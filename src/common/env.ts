/**
 * 环境变量加载（必须在其它模块之前 import）
 *
 * 顺序：~/.hotwave/.env → <cwd>/.env（后者覆盖前者，方便仓库内开发时临时改配置）。
 * 用 ~/.hotwave/.env 的原因：npm 全局安装后 cwd 是用户随手敲命令的目录，不能靠它定位配置。
 */

import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { hotwavePaths } from './paths.js';

export function loadEnvFiles(): string[] {
  const files = [hotwavePaths().envFile, path.join(process.cwd(), '.env')];
  const loaded: string[] = [];
  for (const file of files) {
    try {
      if (!fs.existsSync(file)) continue;
      dotenv.config({ path: file, override: true, quiet: true });
      loaded.push(file);
    } catch {
      /* ignore */
    }
  }
  return loaded;
}

export const loadedEnvFiles = loadEnvFiles();
