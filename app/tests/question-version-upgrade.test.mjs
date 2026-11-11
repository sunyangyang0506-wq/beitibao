import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import { seedLegacyQuestionCorrection, verifyLegacyQuestionCorrection } from './fixtures/question-version-upgrade.mjs';

// test-local.sh provisions a separate empty scratch database owned by a
// NOSUPERUSER NOBYPASSRLS role. Never point these URLs at an application database.
test('039 to 040 upgrades legacy corrections under a non-superuser table owner and restores RLS',async()=>{
  assert.ok(process.env.VERSION_UPGRADE_DATABASE_URL,'Run through npm test to provision the isolated upgrade database');
  assert.ok(process.env.VERSION_UPGRADE_ADMIN_DATABASE_URL);
  const owner=new pg.Pool({connectionString:process.env.VERSION_UPGRADE_DATABASE_URL});
  const admin=new pg.Pool({connectionString:process.env.VERSION_UPGRADE_ADMIN_DATABASE_URL});
  try {
    const identity=(await owner.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
    assert.deepEqual(identity,{rolsuper:false,rolbypassrls:false});
    const empty=(await owner.query("SELECT to_regclass('public.accounts') AS accounts")).rows[0];
    assert.equal(empty.accounts,null,'Upgrade test database must be empty');
    const directory=new URL('../migrations/',import.meta.url);
    for(const file of (await readdir(directory)).sort()) {
      if(file.endsWith('.sql')&&file<'040') await owner.query(await readFile(new URL(file,directory),'utf8'));
    }
    const fixture=await seedLegacyQuestionCorrection((sql,values)=>admin.query(sql,values));
    await owner.query(await readFile(new URL('040_question_versions.sql',directory),'utf8'));
    await verifyLegacyQuestionCorrection((sql,values)=>owner.query(sql,values),fixture);
  } finally {await owner.end();await admin.end();}
});
