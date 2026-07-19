// Design Lab 索引页 — T1 视觉方向稿入口（暗色-only 原型，不接真实数据）
import { Link } from 'react-router-dom';
import './design-lab.css';

export function DesignLabPage() {
  return (
    <div className="dl-index">
      <header className="dl-index-head">
        <h1 className="dl-index-title">Design Lab · 主界面视觉方向稿</h1>
        <p className="dl-index-sub">
          同一套信息架构（左频道 / 中对话流 / 右抽屉），两套视觉语言。轴向互相独立，可按 底色 / 字体 / 密度 / 动效 混搭。
        </p>
      </header>
      <div className="dl-index-grid">
        <Link className="dl-index-card" to="/design-lab/a">
          <div className="dl-index-card-tag dl-index-swatch-a">Direction A</div>
          <h2 className="dl-index-card-name">Mission Control 控制台</h2>
          <p className="dl-index-card-desc">
            近纯黑底色，标题与数据全部等宽字体，信息密度收紧、数据对齐成列、单行截断；动效最少，仅状态点 pulse。accent 走磷光青绿的终端感。
          </p>
          <div className="dl-index-card-axes">
            <span className="dl-index-axis">底色 #050507</span>
            <span className="dl-index-axis">全等宽 12.5px</span>
            <span className="dl-index-axis">密度：紧</span>
            <span className="dl-index-axis">动效：仅 pulse</span>
          </div>
        </Link>
        <Link className="dl-index-card" to="/design-lab/b">
          <div className="dl-index-card-tag dl-index-swatch-b">Direction B</div>
          <h2 className="dl-index-card-name">深夜编辑部</h2>
          <p className="dl-index-card-desc">
            深灰微暖底色，衬线标题 + 人文无衬线正文、等宽只留给数据；留白更多，分区靠留白而非边框；克制动效 ≤200ms ease-out。accent 走暖金纸墨色。
          </p>
          <div className="dl-index-card-axes">
            <span className="dl-index-axis">底色 #12141a</span>
            <span className="dl-index-axis">衬线标题 14px</span>
            <span className="dl-index-axis">密度：松</span>
            <span className="dl-index-axis">动效：≤200ms</span>
          </div>
        </Link>
      </div>
    </div>
  );
}
