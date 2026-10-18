const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// PostgreSQL + PostGIS 연결 풀 설정
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || '1234',
  database: process.env.DB_NAME || 'bizcompass',
});

// 공통 상권 공간 분석 함수 (실무형 지표 보정)
async function analyzeRegion(lat, lng, radius, category = 'ALL') {
  let query = `
    SELECT 
      s.store_id,
      s.name,
      COALESCE(c.middle_name, '일반상가') AS category,
      ROUND(ST_Distance(s.geom::geography, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography)) AS distance_meter,
      ST_X(s.geom) AS lng,
      ST_Y(s.geom) AS lat
    FROM STORE s
    LEFT JOIN CATEGORY c ON s.category_code = c.category_code
    WHERE ST_DWithin(s.geom::geography, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, $3)
  `;

  const params = [lng, lat, radius];

  if (category && category !== 'ALL') {
    query += ` AND (c.middle_name LIKE $4 OR s.name LIKE $4)`;
    params.push(`%${category}%`);
  }

  query += ` ORDER BY distance_meter ASC LIMIT 500;`; // 브라우저 렌더링 과부하 방지 (상위 500개)

  // 전체 건수 집계 쿼리 (별도 카운트)
  const countQuery = `
    SELECT COUNT(*) AS total_count
    FROM STORE s
    WHERE ST_DWithin(s.geom::geography, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, $3)
  `;
  
  const [storeRows, countRes] = await Promise.all([
    pool.query(query, params),
    pool.query(countQuery, [lng, lat, radius])
  ]);

  const totalStores = parseInt(countRes.rows[0].total_count, 10);
  const rows = storeRows.rows;

  // 유동인구 모델
  const estimatedFootTraffic = Math.round(radius * 65 + (lng % 0.01) * 35000);
  
  // 과밀 상권 로그 스케일 적합도 (점포 수 5,000개 대응)
  const densityIndex = Math.min(100, Math.round(Math.log10(totalStores + 1) * 22));
  const suitabilityScore = Math.max(30, Math.min(95, Math.round(85 - (densityIndex * 0.5))));

  // 4대 경기 지표 정규화 (음수 방지)
  const estimatedSales = Math.max(1200, Math.round(4500 - (densityIndex * 15) + (estimatedFootTraffic / 1000)));
  const estimatedRent = (20.5 + (densityIndex * 0.12)).toFixed(1);
  const closureRate = Math.min(8.5, Math.max(1.1, (2.0 + (densityIndex * 0.05)))).toFixed(1);
  const stayTime = Math.min(65, Math.round(35 + (estimatedFootTraffic / 1500)));

  return {
    center: { lat, lng },
    radius_meter: radius,
    store_count: totalStores,
    estimated_foot_traffic: estimatedFootTraffic,
    suitability_score: suitabilityScore,
    business_metrics: {
      estimated_sales: estimatedSales,
      estimated_rent: estimatedRent,
      closure_rate: closureRate,
      stay_time: stayTime
    },
    radar_metrics: {
      accessibility: Math.min(95, Math.round(75 + (estimatedFootTraffic / 2000))),
      customer_power: Math.min(92, Math.round(suitabilityScore * 0.95)),
      stability: Math.max(40, Math.round(90 - (densityIndex * 0.6))),
      growth: Math.min(95, Math.round(65 + (radius / 25))),
      purchasing_power: 88
    },
    stores: rows
  };
}

// =================================================================
// [API-01] 단일 상권 반경 검색: GET /api/v1/stores/radius
// =================================================================
app.get('/api/v1/stores/radius', async (req, res) => {
  try {
    const lat = parseFloat(req.query.lat) || 37.5000;
    const lng = parseFloat(req.query.lng) || 127.0360;
    const radius = parseInt(req.query.radius, 10) || 500;
    const category = req.query.category || 'ALL';

    const result = await analyzeRegion(lat, lng, radius, category);

    res.json({
      status: 200,
      message: 'SUCCESS',
      ...result
    });
  } catch (error) {
    console.error('[API-01] Query Error:', error);
    res.status(500).json({ status: 500, error: 'Database Spatial Query Failed' });
  }
});

// =================================================================
// [API-02] A/B 듀얼 후보 상권 1:1 비교 분석: POST /api/v1/analysis/compare
// =================================================================
app.post('/api/v1/analysis/compare', async (req, res) => {
  try {
    const { region_a, region_b, category = 'ALL' } = req.body;

    if (!region_a || !region_b) {
      return res.status(400).json({
        status: 400,
        error: 'Bad Request: Both region_a and region_b coordinate objects are required.'
      });
    }

    const latA = parseFloat(region_a.lat) || 37.5000;
    const lngA = parseFloat(region_a.lng) || 127.0360;
    const radiusA = parseInt(region_a.radius, 10) || 500;

    const latB = parseFloat(region_b.lat) || 37.4979;
    const lngB = parseFloat(region_b.lng) || 127.0276;
    const radiusB = parseInt(region_b.radius, 10) || 500;

    // A 상권과 B 상권의 PostGIS 공간 질의 및 통계 분석을 병렬 실행
    const [resultA, resultB] = await Promise.all([
      analyzeRegion(latA, lngA, radiusA, category),
      analyzeRegion(latB, lngB, radiusB, category)
    ]);

    const diffScore = resultA.suitability_score - resultB.suitability_score;
    const diffStores = resultA.store_count - resultB.store_count;
    const diffFoot = resultA.estimated_foot_traffic - resultB.estimated_foot_traffic;

    // 우위 판정(Verdict) 메시지 자동 생성
    let verdict = '';
    if (diffScore > 0) {
      verdict = `A 상권이 경쟁 밀집도 대비 유동인구 지표에서 B 상권보다 ${diffScore}점 더 높은 우위를 점하고 있어 창업 위험도가 상대적으로 낮습니다.`;
    } else if (diffScore < 0) {
      verdict = `B 상권이 배후 고객 흡수력 지표에서 A 상권보다 ${Math.abs(diffScore)}점 더 높은 우위를 나타내어 매출 잠재력이 더 큽니다.`;
    } else {
      verdict = 'A 상권과 B 상권의 종합 적합도가 동일한 수준으로, 고정 임대료와 권리금 조건을 추가 비교하여 입지를 선정해야 합니다.';
    }

    res.json({
      status: 200,
      message: 'SUCCESS',
      data: {
        comparison_summary: {
          score_a: resultA.suitability_score,
          score_b: resultB.suitability_score,
          diff_score: diffScore,
          stores_a: resultA.store_count,
          stores_b: resultB.store_count,
          diff_stores: diffStores,
          foot_traffic_a: resultA.estimated_foot_traffic,
          foot_traffic_b: resultB.estimated_foot_traffic,
          diff_foot_traffic: diffFoot,
          verdict: verdict
        },
        region_a: resultA,
        region_b: resultB
      }
    });
  } catch (error) {
    console.error('[API-02] Compare Error:', error);
    res.status(500).json({ status: 500, error: 'Dual Region Analysis Failed' });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`[Biz-Compass Backend] Server started on http://localhost:${PORT}`);
});