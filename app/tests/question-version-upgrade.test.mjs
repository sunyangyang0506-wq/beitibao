import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
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

    for (const file of (await readdir(directory)).sort()) {
      if (file.endsWith('.sql') && file >= '041' && file < '043') await owner.query(await readFile(new URL(file,directory),'utf8'));
    }
    const oldPaper = randomUUID();
    const { tenant } = fixture;
    const { rows: [course] } = await admin.query('SELECT id FROM courses WHERE tenant_id=$1', [tenant]);
    await admin.query(`INSERT INTO papers (tenant_id,id,course_id,title,fingerprint,pdf,status,pages,model_allowed)
      VALUES ($1,$2,$3,'Previously published PDF',$2::uuid::text,$4,'review','["page"]',true)`, [tenant, oldPaper, course.id, Buffer.alloc(0)]);
    const recognition = { stems: ['1. Read the directed graph.', '2. A text question.'],
      figures: [[{ status: 'needs_review', reason: 'conflict' }], []] };
    await admin.query(`INSERT INTO paper_page_recognition (tenant_id,paper_id,page_number,status,recognition)
      VALUES ($1,$2,1,'review',$3)`, [tenant, oldPaper, JSON.stringify(recognition)]);
    await admin.query('SELECT publish_recognized_pdf_page($1,$2,1)', [tenant, oldPaper]);
    const { rows: [legacy] } = await admin.query('SELECT id FROM paper_questions WHERE paper_id=$1 AND stem=$2', [oldPaper, recognition.stems[0]]);
    await admin.query(`UPDATE paper_questions SET solution_status='ready', model_solution='{"status":"solved","answer":"unverified"}'
      WHERE tenant_id=$1 AND id=$2`, [tenant, legacy.id]);
    await owner.query(await readFile(new URL('043_pdf_figure_review.sql',directory),'utf8'));
    const { rows: upgraded } = await admin.query(`SELECT id, figure_review_blocked, solution_status, stem
      FROM paper_questions WHERE paper_id=$1 ORDER BY stem`, [oldPaper]);
    assert.equal(upgraded.length, 2);
    assert.equal(upgraded[0].id, legacy.id);
    assert.equal(upgraded[0].figure_review_blocked, true);
    assert.equal(upgraded[0].solution_status, null);
    assert.equal(upgraded[1].figure_review_blocked, false);
    assert.equal((await admin.query('SELECT reviewed_at FROM paper_page_recognition WHERE paper_id=$1', [oldPaper])).rows[0].reviewed_at, null);
    const { rows: policies } = await owner.query(`SELECT relforcerowsecurity FROM pg_class
      WHERE relname IN ('paper_questions','paper_page_recognition','recognition_feedback','question_equivalence')`);
    assert.equal(policies.length, 4);
    assert.ok(policies.every(row => row.relforcerowsecurity));
  } finally {await owner.end();await admin.end();}
});
