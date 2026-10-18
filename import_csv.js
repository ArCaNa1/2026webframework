const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const { Pool } = require('pg');

const pool = new Pool({
  host: 'localhost',
  port: 5432,
  user: 'postgres',
  password: '1234',
  database: 'bizcompass',
});

const CSV_FILE_PATH = path.join(__dirname, 'seoul_stores.csv');
const BATCH_SIZE = 1000; // 1,000건씩 안전하게 배치 처리

async function runBatchInsert(rows) {
  if (rows.length === 0) return;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const insertQuery = `
      INSERT INTO STORE (store_id, name, branch_name, dong_code, geom)
      SELECT 
        u.store_id,
        u.name,
        u.branch_name,
        u.dong_code,
        ST_SetSRID(ST_MakePoint(u.lng, u.lat), 4326)
      FROM UNNEST(
        $1::text[],
        $2::text[],
        $3::text[],
        $4::text[],
        $5::float8[],
        $6::float8[]
      ) AS u(store_id, name, branch_name, dong_code, lng, lat)
      ON CONFLICT (store_id) DO NOTHING;
    `;

    const storeIds = [];
    const names = [];
    const branchNames = [];
    const dongCodes = [];
    const lngs = [];
    const lats = [];

    rows.forEach(r => {
      storeIds.push(r.store_id);
      names.push(r.name);
      branchNames.push(r.branch_name);
      dongCodes.push(r.dong_code);
      lngs.push(r.lng);
      lats.push(r.lat);
    });

    await client.query(insertQuery, [storeIds, names, branchNames, dongCodes, lngs, lats]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function importStores() {
  if (!fs.existsSync(CSV_FILE_PATH)) {
    console.error(`[오류] 파일을 찾을 수 없습니다: ${CSV_FILE_PATH}`);
    process.exit(1);
  }

  console.log(`[Biz-Compass] 대용량 CSV 적재 시작: ${CSV_FILE_PATH}`);
  const startTime = Date.now();

  let batch = [];
  let totalCount = 0;

  // for-await 루프로 스트림을 순차 처리하여 비동기 동시성 에러 방지
  const stream = fs.createReadStream(CSV_FILE_PATH).pipe(csv());

  for await (const row of stream) {
    // 공공데이터 CSV 컬럼 매핑
    const rawId = row['상가업소번호'] || row['store_id'];
    const name = row['상호명'] || row['name'];
    const branchName = row['지점명'] || row['branch_name'] || '';
    const dongCode = row['행정동코드'] || row['법정동코드'] || row['dong_code'] || '';
    const lng = parseFloat(row['경도'] || row['lng']);
    const lat = parseFloat(row['위도'] || row['lat']);

    // NaN 방지: parseInt 하지 않고 문자열 ID 원본 그대로 적재
    if (rawId && name && !isNaN(lat) && !isNaN(lng)) {
      batch.push({
        store_id: String(rawId).trim(),
        name: String(name).slice(0, 100),
        branch_name: String(branchName).slice(0, 50),
        dong_code: String(dongCode).slice(0, 10),
        lng: lng,
        lat: lat
      });

      if (batch.length >= BATCH_SIZE) {
        await runBatchInsert(batch);
        totalCount += batch.length;
        process.stdout.write(`\r>> 누적 적재 건수: ${totalCount.toLocaleString()}건 완료...`);
        batch = [];
      }
    }
  }

  if (batch.length > 0) {
    await runBatchInsert(batch);
    totalCount += batch.length;
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n======================================================`);
  console.log(`[완료] 총 ${totalCount.toLocaleString()}건의 상가 점포가 PostGIS에 성공적으로 적재되었습니다.`);
  console.log(`소요 시간: ${elapsed}초`);
  console.log(`======================================================`);

  await pool.end();
}

importStores();