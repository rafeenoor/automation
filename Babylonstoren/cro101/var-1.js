// app.js — CRP workflow with modal-safe acks (push/update/errors) and no DMs
require('dotenv').config();
const express = require('express');
const { App, ExpressReceiver, LogLevel } = require('@slack/bolt');
const { Octokit } = require('@octokit/rest');

// ───────────────────────────────────────────────────────────────────────────────
// Receiver / health / Slack challenge
// ───────────────────────────────────────────────────────────────────────────────
const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  endpoints: { events: '/slack/events', commands: '/slack/commands', actions: '/slack/actions' },
});
receiver.router.get('/', (_req, res) => res.status(200).send('ok'));
receiver.router.post('/slack/events', express.json(), (req, res, next) => {
  if (req.body?.type === 'url_verification') return res.status(200).send(req.body.challenge);
  return next();
});

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver,
  logLevel: LogLevel.INFO,
});

// ───────────────────────────────────────────────────────────────────────────────
// GitHub
// ───────────────────────────────────────────────────────────────────────────────
const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
const DEFAULT_BRANCH = process.env.GITHUB_DEFAULT_BRANCH || 'main';

async function githubGetFileSha({ owner, repo, path, ref }) {
  try {
    const res = await octokit.repos.getContent({ owner, repo, path, ref });
    if (Array.isArray(res.data)) return 'DIR';
    if (res.data && res.data.sha) return res.data.sha;
    return null;
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}
async function githubWriteFile({ owner, repo, path, content, message, branch, sha }) {
  const b64 = Buffer.from(content || '', 'utf8').toString('base64');
  await octokit.repos.createOrUpdateFileContents({
    owner, repo, path, message, content: b64, branch, sha
  });
}

// ───────────────────────────────────────────────────────────────────────────────
// Config (CLIENTS_JSON)
// ───────────────────────────────────────────────────────────────────────────────
let CLIENTS = {};
try { CLIENTS = JSON.parse(process.env.CLIENTS_JSON || '{}'); }
catch { console.error('Invalid CLIENTS_JSON in .env'); CLIENTS = {}; }
const clientOptions = Object.keys(CLIENTS).map(k => ({
  text: { type: 'plain_text', text: k }, value: k
}));

function getStateValue(state, blockId, actionId) {
  return state.values?.[blockId]?.[actionId]?.value
      || state.values?.[blockId]?.[actionId]?.selected_option?.value
      || null;
}

// ───────────────────────────────────────────────────────────────────────────────
// 1) Slash command → open the first modal
// ───────────────────────────────────────────────────────────────────────────────
app.command('/crp', async ({ command, ack, client }) => {
  await ack();
  await client.views.open({
    trigger_id: command.trigger_id,
    view: {
      type: 'modal',
      callback_id: 'crp_pick_client_test',
      title: { type: 'plain_text', text: 'CRP Automation' },
      submit: { type: 'plain_text', text: 'Continue' },
      close: { type: 'plain_text', text: 'Cancel' },
      blocks: [
        {
          type: 'input',
          block_id: 'client_block',
          label: { type: 'plain_text', text: 'Choose client' },
          element: {
            type: 'static_select',
            action_id: 'client_select',
            placeholder: { type: 'plain_text', text: 'Select a client' },
            options: clientOptions
          }
        },
        {
          type: 'input',
          block_id: 'testname_block',
          label: { type: 'plain_text', text: 'Test name' },
          element: {
            type: 'plain_text_input',
            action_id: 'test_name',
            placeholder: { type: 'plain_text', text: 'e.g. hero-banner-cta' }
          }
        }
      ]
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// 2) Submit first modal → check GitHub, then PUSH next modal
// ───────────────────────────────────────────────────────────────────────────────
app.view('crp_pick_client_test', async ({ ack, view }) => {
  const clientKey = getStateValue(view.state, 'client_block', 'client_select');
  const testName  = (getStateValue(view.state, 'testname_block', 'test_name') || '').trim();

  // Inline validation (keeps us inside the modal; no DM needed)
  if (!clientKey || !testName) {
    await ack({
      response_action: 'errors',
      errors: {
        ...( !clientKey ? { client_block: 'Please select a client.' } : {} ),
        ...( !testName  ? { testname_block: 'Please enter a test name.' } : {} ),
      }
    });
    return;
  }

  const cfg = CLIENTS[clientKey];
  if (!cfg) {
    await ack({
      response_action: 'errors',
      errors: { client_block: 'Unknown client in configuration.' }
    });
    return;
  }

  const dirPath = `${cfg.testsPath}/${testName}`;

  // Try to detect existence quickly so we can respond in this ack
  let exists = false;
  try {
    const sha = await githubGetFileSha({ owner: cfg.owner, repo: cfg.repo, path: dirPath, ref: DEFAULT_BRANCH });
    exists = !!sha;
  } catch (e) {
    // Show a friendly error in the current modal
    await ack({
      response_action: 'update',
      view: {
        type: 'modal',
        callback_id: 'noop',
        title: { type: 'plain_text', text: 'CRP Automation' },
        close: { type: 'plain_text', text: 'Close' },
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text: `❌ GitHub check failed:\n\`${e.message}\`` } }
        ]
      }
    });
    return;
  }

  // Push a new modal onto the stack (Slack keeps us in modal flow)
  await ack({
    response_action: 'push',
    view: {
      type: 'modal',
      callback_id: 'crp_update_or_create',
      private_metadata: JSON.stringify({ clientKey, testName, exists }),
      title: { type: 'plain_text', text: 'CRP Automation' },
      close: { type: 'plain_text', text: 'Cancel' },
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn',
            text: exists
              ? `*Test found:* \`${dirPath}\`\nWhat would you like to do?`
              : `*No existing test* at \`${dirPath}\`.`
          }
        },
        {
          type: 'actions',
          block_id: 'choice_block',
          elements: [
            { type: 'button', text: { type: 'plain_text', text: 'Create New' }, value: 'create', action_id: 'choose_create' },
            ...(exists ? [{ type: 'button', text: { type: 'plain_text', text: 'Update Existing' }, value: 'update', action_id: 'choose_update' }] : [])
          ]
        }
      ]
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// 3a) Choose "Create New" → update current modal to ask # of variations
// ───────────────────────────────────────────────────────────────────────────────
app.action('choose_create', async ({ ack, body, client }) => {
  await ack();
  try {
    await client.views.update({
      view_id: body.view.id,
      view: {
        type: 'modal',
        callback_id: 'crp_collect_variation_count',
        private_metadata: body.view.private_metadata,
        title: { type: 'plain_text', text: 'Create New Test' },
        submit: { type: 'plain_text', text: 'Continue' },
        close: { type: 'plain_text', text: 'Cancel' },
        blocks: [
          {
            type: 'input',
            block_id: 'varcount_block',
            label: { type: 'plain_text', text: 'Number of variations (1-5)' },
            element: { type: 'plain_text_input', action_id: 'var_count', initial_value: '1' }
          }
        ]
      }
    });
  } catch (e) {
    console.error('choose_create update error:', e);
  }
});

// Collect variation count (submission) → UPDATE modal with snippet fields
app.view('crp_collect_variation_count', async ({ ack, view }) => {
  const { clientKey, testName } = JSON.parse(view.private_metadata);
  const raw = getStateValue(view.state, 'varcount_block', 'var_count') || '1';
  const count = Math.max(1, Math.min(5, parseInt(raw, 10) || 1));

  const blocks = [];
  for (let i = 1; i <= count; i++) {
    blocks.push(
      { type: 'header', text: { type: 'plain_text', text: `Variation ${i}` } },
      { type: 'input', block_id: `js_${i}`, label: { type: 'plain_text', text: `JS snippet ${i}` },
        element: { type: 'plain_text_input', action_id: 'val', multiline: true } },
      { type: 'input', block_id: `css_${i}`, label: { type: 'plain_text', text: `CSS snippet ${i}` },
        element: { type: 'plain_text_input', action_id: 'val', multiline: true } }
    );
  }

  await ack({
    response_action: 'update',
    view: {
      type: 'modal',
      callback_id: 'crp_create_commit',
      private_metadata: JSON.stringify({ clientKey, testName, count }),
      title: { type: 'plain_text', text: 'New Test Snippets' },
      submit: { type: 'plain_text', text: 'Create' },
      close: { type: 'plain_text', text: 'Cancel' },
      blocks
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// 3b) Submit snippets → write to GitHub, then UPDATE modal with result
// ───────────────────────────────────────────────────────────────────────────────
app.view('crp_create_commit', async ({ ack, view }) => {
  const { clientKey, testName, count } = JSON.parse(view.private_metadata);
  const cfg = CLIENTS[clientKey];

  const ops = [];
  for (let i = 1; i <= count; i++) {
    const js  = getStateValue(view.state, `js_${i}`, 'val')  || '';
    const css = getStateValue(view.state, `css_${i}`, 'val') || '';
    const base = `${cfg.testsPath}/${testName}/var-${i}`;
    ops.push({ path: `${base}.js`, content: js });
    ops.push({ path: `${base}.css`, content: css });
  }

  try {
    for (const op of ops) {
      const sha = await githubGetFileSha({ owner: cfg.owner, repo: cfg.repo, path: op.path, ref: DEFAULT_BRANCH });
      await githubWriteFile({
        owner: cfg.owner, repo: cfg.repo, path: op.path, content: op.content,
        message: `CRP: create ${testName} (${clientKey}) -> ${op.path}`,
        branch: DEFAULT_BRANCH, sha: sha || undefined
      });
    }

    await ack({
      response_action: 'update',
      view: {
        type: 'modal',
        callback_id: 'noop',
        title: { type: 'plain_text', text: 'Created ✅' },
        close: { type: 'plain_text', text: 'Close' },
        blocks: [
          { type: 'section',
            text: { type: 'mrkdwn', text: `Created *${testName}* for *${clientKey}* with ${count} variation(s).` } }
        ]
      }
    });
  } catch (e) {
    await ack({
      response_action: 'update',
      view: {
        type: 'modal',
        callback_id: 'noop',
        title: { type: 'plain_text', text: 'Error' },
        close: { type: 'plain_text', text: 'Close' },
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text: `❌ GitHub error creating files:\n\`${e.message}\`` } }
        ]
      }
    });
  }
});

// ───────────────────────────────────────────────────────────────────────────────
// 4) Choose "Update Existing" → update current modal to capture inputs
// ───────────────────────────────────────────────────────────────────────────────
app.action('choose_update', async ({ ack, body, client }) => {
  await ack();
  const { clientKey, testName } = JSON.parse(body.view.private_metadata);
  const cfg = CLIENTS[clientKey];
  const baseDir = `${cfg.testsPath}/${testName}`;

  await client.views.update({
    view_id: body.view.id,
    view: {
      type: 'modal',
      callback_id: 'crp_update_commit',
      private_metadata: body.view.private_metadata,
      title: { type: 'plain_text', text: 'Update Existing Test' },
      submit: { type: 'plain_text', text: 'Update' },
      close: { type: 'plain_text', text: 'Cancel' },
      blocks: [
        { type: 'section',
          text: { type: 'mrkdwn', text: `Updating files under \`${baseDir}\` (default: var-1)` } },
        { type: 'input', block_id: 'var_id', label: { type: 'plain_text', text: 'Variation number' },
          element: { type: 'plain_text_input', action_id: 'val', initial_value: '1' } },
        { type: 'input', block_id: 'u_js', label: { type: 'plain_text', text: 'New JS snippet' },
          element: { type: 'plain_text_input', action_id: 'val', multiline: true } },
        { type: 'input', block_id: 'u_css', label: { type: 'plain_text', text: 'New CSS snippet' },
          element: { type: 'plain_text_input', action_id: 'val', multiline: true } }
      ]
    }
  });
});

// Submit update → write to GitHub, then UPDATE modal with result
app.view('crp_update_commit', async ({ ack, view }) => {
  const { clientKey, testName } = JSON.parse(view.private_metadata);
  const cfg = CLIENTS[clientKey];
  const v   = parseInt(getStateValue(view.state, 'var_id', 'val') || '1', 10);
  const js  = getStateValue(view.state, 'u_js', 'val')  || '';
  const css = getStateValue(view.state, 'u_css', 'val') || '';

  const jsPath  = `${cfg.testsPath}/${testName}/var-${v}.js`;
  const cssPath = `${cfg.testsPath}/${testName}/var-${v}.css`;

  try {
    const jsSha  = await githubGetFileSha({ owner: cfg.owner, repo: cfg.repo, path: jsPath,  ref: DEFAULT_BRANCH });
    const cssSha = await githubGetFileSha({ owner: cfg.owner, repo: cfg.repo, path: cssPath, ref: DEFAULT_BRANCH });

    await githubWriteFile({
      owner: cfg.owner, repo: cfg.repo, path: jsPath, content: js,
      message: `CRP: update ${testName} var-${v}.js`, branch: DEFAULT_BRANCH, sha: jsSha || undefined
    });
    await githubWriteFile({
      owner: cfg.owner, repo: cfg.repo, path: cssPath, content: css,
      message: `CRP: update ${testName} var-${v}.css`, branch: DEFAULT_BRANCH, sha: cssSha || undefined
    });

    await ack({
      response_action: 'update',
      view: {
        type: 'modal',
        callback_id: 'noop',
        title: { type: 'plain_text', text: 'Updated ✅' },
        close: { type: 'plain_text', text: 'Close' },
        blocks: [
          { type: 'section',
            text: { type: 'mrkdwn', text: `Updated *${testName}* variation *${v}* for *${clientKey}*.` } }
        ]
      }
    });
  } catch (e) {
    await ack({
      response_action: 'update',
      view: {
        type: 'modal',
        callback_id: 'noop',
        title: { type: 'plain_text', text: 'Error' },
        close: { type: 'plain_text', text: 'Close' },
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text: `❌ GitHub update failed:\n\`${e.message}\`` } }
        ]
      }
    });
  }
});

// (optional) mention
app.event('app_mention', async ({ event, say }) => {
  await say(`👋 Hello <@${event.user}>, your bot is working!`);
});

// Start
(async () => {
  await app.start(process.env.PORT || 3000);
  console.log(`⚡ CRP bot is running on port ${process.env.PORT || 3000}`);
})();