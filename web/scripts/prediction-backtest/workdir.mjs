// 回测工作目录：逐时序列、原始响应缓存、masterdata 快照（wlrules/）、本机榜线存档（jp-border-data/）
// 与拟合/回测输出（prediction-model/）都放在这里，体积大，不提交。
// 用环境变量 PREDICTION_WORKDIR 指定；未设置时为 web/.cache/prediction（已被 .gitignore 忽略）。
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const WORK_ROOT = path.resolve(process.env.PREDICTION_WORKDIR || path.join(HERE, "../../.cache/prediction"));
