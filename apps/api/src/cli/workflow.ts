// ── 执行/审批域（2026-07-20 自 studio-cli.ts 按命令域拆分）──
// studio run / approve / reject

export async function studioRun() {
  const args = process.argv.slice(3);
  const requirement = args.join(' ').trim();

  if (!requirement) {
    console.error('Usage: studio run "requirement description"');
    process.exit(1);
  }

  const port = process.env.PORT || '3001';
  const baseUrl = `http://localhost:${port}/api/v1`;

  try {
    // Get #研发 channel
    const chResp = await fetch(`${baseUrl}/channels`);
    const { data: channels } = await chResp.json() as { data: Array<{ id: string; type: string; name: string }> };
    // Dev mode → prefer #研发-dev, prod → prefer #研发 (skip -dev suffixed)
    const isDev = process.env.NODE_ENV === 'development';
    const rndChannel = isDev
      ? channels.find((c: any) => c.type === 'rnd' && c.name?.endsWith('-dev'))
      : channels.find((c: any) => c.type === 'rnd' && !c.name?.endsWith('-dev'));
    if (!rndChannel) {
      console.error(`No ${isDev ? '#研发-dev' : '#研发'} channel found. Start studio with: studio up`);
      process.exit(1);
    }

    // Send message (@mention → WorkUnit creation in route handler)
    const content = /@analyst/i.test(requirement) ? requirement : `${requirement} @Analyst`;
    const msgResp = await fetch(`${baseUrl}/channels/${rndChannel.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    const msgResult = await msgResp.json() as { success: boolean; data?: { id: string }; error?: string };

    if (!msgResult.success) {
      console.error('Failed to submit:', msgResult.error);
      process.exit(1);
    }

    console.log(`✅ Submitted to ${rndChannel.name}. Analyst is analyzing...`);
  } catch (err: any) {
    console.error('Failed to connect to studio server:', err.message);
    console.error('Make sure studio is running: studio up');
    process.exit(1);
  }
}

// ─── studio approve/reject ───

export async function studioApprove() {
  const sub = process.argv[3];
  const port = parseInt(process.env.PORT || '3001');
  const baseUrl = `http://localhost:${port}/api/v1`;

  if (sub === 'list') {
    console.log('Pending Approvals');
    console.log('━━━━━━━━━━━━━━━━━');
    let found = 0;

    try {
      const chResp = await fetch(`${baseUrl}/channels`);
      const { data: channels } = await chResp.json() as { data: Array<{ id: string; type: string; name: string }> };

      for (const ch of channels) {
        const msgsResp = await fetch(`${baseUrl}/channels/${ch.id}/messages?limit=20`);
        const { data: msgs } = await msgsResp.json() as { data: Array<{ id: string; meta: any; content: string; createdAt: string }> };

        for (const m of msgs) {
          let meta = m.meta; if (typeof meta === 'string') try { meta = JSON.parse(meta); } catch {}
          const cardType = meta?.cardType;
          if (!cardType) continue;

          const pending = meta?.status === 'ready' || meta?.status === 'pending';
          if (!pending) continue;

          found++;
          const id = m.id.slice(0, 8);
          const channel = ch.name;
          const date = new Date(m.createdAt).toLocaleTimeString();
          const content = (m.content || '').slice(0, 60);

          switch (cardType) {
            case 'requirements_doc':
              console.log(`  📋 [${id}] ${channel} | 需求文档 | ${date}`);
              console.log(`     → ${content}`);
              console.log(`     studio approve req ${m.id}`);
              break;
            case 'knowledge_confirm':
              console.log(`  🧠 [${id}] ${channel} | 知识确认 | ${date}`);
              console.log(`     → studio approve knowledge ${m.id}`);
              break;
            case 'skill_review_request':
              console.log(`  🔩 [${id}] ${channel} | Skill 待审批 | ${date}`);
              console.log(`     → studio approve skill ${m.id}`);
              break;
            case 'auditor_suggestion':
              console.log(`  📊 [${id}] ${channel} | 审计建议 | ${date}`);
              console.log(`     → studio approve auditor ${m.id}`);
              break;
            case 'deploy_approval':
              console.log(`  🚀 [${id}] ${channel} | 部署审批 | ${date}`);
              console.log(`     → studio approve deploy ${m.id}`);
              break;
            default:
              console.log(`  ❓ [${id}] ${channel} | ${cardType} | ${date}`);
              console.log(`     → studio approve ${cardType} ${m.id}`);
          }
          console.log('');
        }
      }

      if (found === 0) console.log('  No pending approvals ✅');
      else console.log(`  Total: ${found} pending`);
    } catch (e: any) {
      console.error('Failed:', e.message);
    }
    return;
  }

  const type = sub;
  const messageId = process.argv[4];
  if (!type || !messageId) {
    console.log('Usage:');
    console.log('  studio approve list                      List all pending approvals');
    console.log('  studio approve req <messageId>           Approve RequirementsDoc → start execution');
    console.log('  studio approve knowledge <messageId>     Approve knowledge entry');
    console.log('  studio approve skill <messageId>         Approve skill proposal');
    console.log('  studio approve auditor <messageId>       Approve auditor suggestion');
    console.log('  studio approve deploy <messageId>        Approve deploy');
    console.log('  studio reject  <type> <messageId>        Reject any pending approval');
    return;
  }

  const channelId = process.argv[5] || '';
  const actionMap: Record<string, string> = {
    req: 'start_execution',
    requirements_doc: 'start_execution',
    knowledge: 'knowledge_confirm',
    knowledge_confirm: 'knowledge_confirm',
    skill: 'skill_review_request', // handled via skill API
    auditor: 'auditor_apply_confirm',
    auditor_suggestion: 'auditor_apply_confirm',
    deploy: 'deploy_approve',
    deploy_approval: 'deploy_approve',
  };
  const action = actionMap[type] || type;

  try {
    // Need to find the channel for this message
    const chResp = await fetch(`${baseUrl}/channels`);
    const { data: channels } = await chResp.json() as { data: Array<{ id: string }> };

    let foundChannel = channelId;
    if (!foundChannel) {
      for (const ch of channels) {
        try {
          const testResp = await fetch(`${baseUrl}/channels/${ch.id}/messages/${messageId}/actions`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'start_execution' }),
          });
          if (testResp.status !== 404) { foundChannel = ch.id; break; }
        } catch {}
      }
    }

    if (!foundChannel) {
      console.error('Could not find channel for message. Specify: studio approve <type> <messageId> <channelId>');
      process.exit(1);
    }

    // Special: skill approval goes through skills API
    if (type === 'skill' || type === 'skill_review_request') {
      console.log(`Approving skill proposal ${messageId}...`);
      const r = await fetch(`${baseUrl}/harness/proposals/${messageId}/review`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approved: true }),
      });
      const d = await r.json() as any;
      if (r.ok) console.log('✅ Approved:', d.data?.status || 'done');
      else console.error('❌ Failed:', d.error || r.status);
      return;
    }

    console.log(`${action} → message ${messageId.slice(0, 8)} (channel ${foundChannel.slice(0, 8)})`);
    const res = await fetch(`${baseUrl}/channels/${foundChannel}/messages/${messageId}/actions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    });
    const data = await res.json() as any;
    if (res.ok && data.success) console.log('✅ Approved');
    else console.error('❌ Failed:', data.error || JSON.stringify(data).slice(0, 100));
  } catch (e: any) {
    console.error('Failed:', e.message);
    process.exit(1);
  }
}

export async function studioReject() {
  const type = process.argv[3];
  const messageId = process.argv[4];
  if (!type || !messageId) {
    console.log('Usage: studio reject <type> <messageId>');
    console.log('  studio reject knowledge <messageId>');
    console.log('  studio reject auditor <messageId>');
    return;
  }

  const port = parseInt(process.env.PORT || '3001');
  const baseUrl = `http://localhost:${port}/api/v1`;

  const actionMap: Record<string, string> = {
    knowledge: 'knowledge_reject',
    knowledge_confirm: 'knowledge_reject',
    auditor: 'auditor_apply_reject',
    auditor_suggestion: 'auditor_apply_reject',
    deploy: 'deploy_reject',
    deploy_approval: 'deploy_reject',
  };
  const action = actionMap[type];
  if (!action) { console.error(`Unknown reject type: ${type}`); process.exit(1); }

  try {
    const chResp = await fetch(`${baseUrl}/channels`);
    const { data: channels } = await chResp.json() as { data: Array<{ id: string }> };
    let foundChannel = '';
    for (const ch of channels) {
      try {
        const testResp = await fetch(`${baseUrl}/channels/${ch.id}/messages/${messageId}/actions`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action }),
        });
        if (testResp.status !== 404) { foundChannel = ch.id; break; }
      } catch {}
    }

    if (!foundChannel) {
      console.error('Could not find channel for message. Specify: studio reject <type> <messageId> <channelId>');
      process.exit(1);
    }

    console.log(`${action} → message ${messageId.slice(0, 8)}`);
    const res = await fetch(`${baseUrl}/channels/${foundChannel}/messages/${messageId}/actions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    });
    const data = await res.json() as any;
    if (res.ok && data.success) console.log('✅ Rejected');
    else console.error('❌ Failed:', data.error || JSON.stringify(data).slice(0, 100));
  } catch (e: any) {
    console.error('Failed:', e.message);
    process.exit(1);
  }
}
