// 三条对照基线；run-all.mjs 与测试按这里的顺序使用。
import { currentEngineBaseline } from "./current-engine.mjs";
import { linearBaseline } from "./linear.mjs";
import { previousEventBaseline } from "./previous-event.mjs";

export { currentEngineBaseline, linearBaseline, previousEventBaseline };

export const BASELINES = [currentEngineBaseline, linearBaseline, previousEventBaseline];
