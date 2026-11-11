# Prototype Instructions

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

Build app UI in `src/`. Keep `.openai/hosting.json`, `worker/index.js`, `scripts/prepare-sites-build.mjs`, and `tests/sites-worker.test.mjs` intact so the same local prototype can be handed to Sites. Before a Sites handoff, run `npm run build` and `npm run test:sites`; the build must leave `dist/client/index.html`, `dist/server/index.js`, and `dist/.openai/hosting.json`.

Support laptop browsers only. Validate the main workflows at 1280 × 800 and 1440 × 900. A phone can scan paper documents into PDF files for upload from the laptop.

The PC flow uses the cool gray and cobalt desktop references. Keep progress across subjects, one separate prediction paper per subject, continuous whole-paper practice with a fixed answer card, and subject → question type → source papers for cross-paper recall.

Keep the practice entry in the “题目背诵” sidebar item. The course progress table ends with “考题预测”. Explain that prediction unlocks after the learner finishes every original in that subject, both in the sidebar and on incomplete course rows.

The mistake notebook filters by subject, question type, and retry status. Show the recorded date in each row.

In the connected paper library, show model-recognized stems, knowledge points, and reference answers. In practice results, use automatic grading with eligible model answers. Show unresolved answers as unable to grade automatically, with no mandatory manual review.

Show a multi-question prediction paper per subject. Use one answer card and one final submission for the entire paper.

Let learners confirm the full set of originals in the subject's paper library. Prepare the prediction automatically after confirmation, recognition and source checks. Reuse the validated prediction for learners at the same school with the same subject and complete authorized source set. Each learner unlocks it through their own progress. Show the question paper, answer fields, and generation method directly on the prediction page after unlock. Keep one submission for the whole paper and show the answers and explanations on the same page after submission.

Accept PDF uploads only. Use a single “上传试卷” button in place of the first-login guide heading. Explain model identification of stems, knowledge points, and reference answers, and provide PDF scanning steps in the library.

Read printed page numbers from authorized originals. Auto-sort a complete consecutive sequence, preserve manual review and flag gaps or duplicates.

Allow batch PDF upload. Treat each PDF as a separate paper named after its file.

In the paper library, show distinct states for recognition in progress, pending review, missing pages, recognition failure, and ready to practice, with the next step beside each paper.

For model-enabled PDF imports, publish checked questions automatically and remove the required manual review step. Allow a personal stem correction during practice.

Name the page preview panel “试题识别预览”. Keep the manual question-entry form and the initial per-page recognition button out of this panel. Open directly to the entire paper. Align each recognition preview with its matching original page in paper order. Render formulas and line breaks in recognized questions, model answers, and explanations. Keep raw PDF extraction in a collapsible section for copying.

For the whole-paper practice view, put the choice answer input directly inside the parentheses and omit the stem-correction entry and per-question marking buttons. The answer card shows answer status and jumps to questions. For the recognition view, show model reference answers directly below their questions and keep detailed explanations collapsible.

In the mistake notebook prototype, support grouping by mistake date, question type, and question type followed by mistake date. Apply active filters before grouping and list recent mistakes first within each group.

The complete PC demo starts with administrator invitation. The learner uses their phone number to activate their account and sign in from the same laptop browser. Separate the sample workspace from each learner's data. For the bundled PDF, replay recognition by matching file contents, then show separate answer and prediction states. Clearly label this as a demo. Keep unrecognized PDFs visible with the next action and avoid fabricated recognition results.
