// ── 模块 sink 装配 ──
// 依赖倒置：注册口在调用方模块，bootstrap 在首次业务调用前注入被调方实现。
// ARCH-02：WorkUnit 的 message/audit/project-read/verification/review 等跨域效果同走此口。
import { registerAuthAuditSink } from '../modules/auth/index.js';
import { registerAlertChannelPoster } from '../modules/notifications/index.js';
import { registerChannelCardPoster } from '../modules/review-proposal/index.js';
import { getAuditService } from '../modules/audit-logs/index.js';
import { getChannelMessageService } from '../modules/channels/index.js';
import { registerWorkUnitSinks } from './workunit-sinks.js';

export function registerModuleSinks(): void {
  registerAuthAuditSink((entry) => getAuditService().log(entry));
  registerAlertChannelPoster((post) =>
    getChannelMessageService()
      .createAgentMessage(
        post.channelId,
        'Studio',
        post.content,
        post.atHuman ? { meta: { atHuman: true } } : undefined,
      )
      .then(() => undefined),
  );
  registerChannelCardPoster((post) =>
    getChannelMessageService()
      .createCardMessage(post.channelId, post.author, post.content, post.cardType, post.cardData)
      .then(() => undefined),
  );
  registerWorkUnitSinks();
}
