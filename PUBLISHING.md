# 发布到 npm

HotWave 的 npm 包名为 **hotwave**，安装后提供同名 CLI。发布完成后，用户可以直接：

~~~bash
npm i -g hotwave
hotwave init
hotwave start
~~~

也可以作为库使用：

~~~bash
npm i hotwave
~~~

## 1. 前置条件

- 一个 npm 账号，并已登录官方 registry。
- 拥有包名 **hotwave**。当前 npmjs 上该名称未被占用；如果发布前被他人占用，需要改用 scope，例如 **@your-scope/hotwave**，并同步修改 package.json 的 name、bin 与文档。
- Node.js >= 22、pnpm >= 10、npm >= 10。
- 如果账号开启了 2FA，发布时需要提供一次性验证码。

注意：本机 npm registry 可能配置为国内镜像（如 npmmirror）。镜像通常只读，不能用于发布。下面的命令都显式指定官方 registry，避免发布到错误地址。

## 2. 发布前检查

~~~bash
pnpm install
pnpm build
npm publish --dry-run --registry=https://registry.npmjs.org
~~~

确认 dry-run 输出：

- 包名 **hotwave**、版本号正确。
- tarball 包含 **dist/**、**src/trader/captcha/worker.py**、**workspace-templates/**、**skills/**、**.env.example**、**requirements.txt**。
- 不包含 **workspace/**、**.env**、**node_modules/**、**__pycache__/**。
- 体积在几百 KB 级别。

**prepublishOnly** 会在正式发布前自动执行 **npm run build**，所以本地没有 dist 也能发布；但先手动 build 一次更容易提前发现编译问题。

也可以先在本机验证安装包：

~~~bash
npm pack --pack-destination /tmp
npm install -g --prefix /tmp/hw-test /tmp/hotwave-0.1.0.tgz --registry=https://registry.npmjs.org
/tmp/hw-test/bin/hotwave --version
~~~

## 3. 登录官方 registry

~~~bash
npm login --registry=https://registry.npmjs.org
npm whoami --registry=https://registry.npmjs.org
~~~

如果终端无法完成浏览器登录，也可以使用 Automation Token：

~~~bash
npm config set //registry.npmjs.org/:_authToken YOUR_TOKEN
~~~

不要把 token 写入仓库内的 **.npmrc**，也不要提交到 Git。

## 4. 发布

首次发布：

~~~bash
npm publish --registry=https://registry.npmjs.org
~~~

如果账号要求 2FA：

~~~bash
npm publish --registry=https://registry.npmjs.org --otp=123456
~~~

如果改成了 scoped 包名，需要显式公开：

~~~bash
npm publish --access public --registry=https://registry.npmjs.org
~~~

package.json 已设置 **publishConfig.access=public**，未改 scope 时使用默认 public 即可。

发布过程会依次执行：

1. **prepublishOnly**：编译 TypeScript，清理 Python 缓存。
2. 按 **files** 字段收集文件，生成 tarball。
3. 上传到 npmjs，并打上 **latest** 标签。

## 5. 发布后验证

~~~bash
npm view hotwave version --registry=https://registry.npmjs.org
npm i -g hotwave
hotwave --version
hotwave init
hotwave doctor
~~~

库方式验证：

~~~bash
mkdir -p /tmp/hw-lib && cd /tmp/hw-lib
npm init -y
npm i hotwave
node -e "import('hotwave').then(m => console.log(Object.keys(m)))"
~~~

## 6. 版本管理

修复发布：

~~~bash
npm version patch
git push --follow-tags
npm publish --registry=https://registry.npmjs.org
~~~

小版本与大版本同理，使用 **minor** 或 **major**。**npm version** 会修改 package.json、创建提交与 Git tag；先推送 tag 再发布，便于追溯。

不要把已发布版本重复 publish。npm 不允许覆盖同版本；任何修改都必须提升版本号。

## 7. 国内镜像同步

发布到 npmjs 后，npmmirror 等镜像可能需要一段时间同步。用户遇到 404 时，可以：

~~~bash
npm i -g hotwave --registry=https://registry.npmjs.org
~~~

或者等待镜像同步完成。

## 8. 回滚与撤回

- 发布后 72 小时内可以撤回指定版本：**npm unpublish hotwave@0.1.0 --registry=https://registry.npmjs.org**
- 超过 72 小时通常不能撤回，应改用弃用标记：**npm deprecate hotwave@0.1.0 "请升级到新版本" --registry=https://registry.npmjs.org**
- 撤回会影响已经安装该版本的用户，优先选择发布修复版本，而不是撤回。

## 9. CI 自动发布（可选）

在 GitHub Actions 中配置 **NODE_AUTH_TOKEN** secret，然后执行：

~~~bash
npm ci
npm run build
npm publish --provenance --access public --registry=https://registry.npmjs.org
~~~

**--provenance** 需要 id-token 权限与 npm 可信发布配置；没有配置时去掉该参数。

## 10. 发布被 403：需要 2FA

如果发布返回：

~~~text
403 Forbidden - PUT https://registry.npmjs.org/<package>
Two-factor authentication or granular access token with bypass 2fa enabled is required to publish packages.
~~~

说明 npm 要求发布者具备 2FA，或使用允许绕过 2FA 的 granular token。先确认账号状态：

~~~bash
npm profile get --registry=https://registry.npmjs.org | grep -i two-factor
~~~

如果显示 **two-factor auth: disabled**，说明账号尚未开启 2FA，直接加 **--otp** 没有验证码可输。

### 方案 A：开启 2FA 后用 OTP 发布

1. 浏览器登录 npmjs.com，进入 Account Settings → Two-Factor Authentication。
2. 使用验证器 App 完成绑定，保存恢复码。
3. 选择对写入操作启用 2FA（auth-and-writes）。
4. 重新发布，并提供当前 6 位验证码：

~~~bash
npm publish --registry=https://registry.npmjs.org --otp=123456
~~~

OTP 每 30 秒失效。如果构建耗时导致验证码过期，重新生成后再执行。npm 也可能在发布过程中交互式提示输入 OTP。

### 方案 B：使用 Granular Access Token

1. npmjs.com → Access Tokens → Generate New Token → **Granular Access Token**。
2. 权限选择 Read and write。
3. Packages 选择 All packages（包尚未发布时通常只能全选）。
4. 勾选 **Bypass 2FA**（若页面要求先开启 2FA，则先执行方案 A）。
5. 生成后立即复制 token，页面关闭后无法再次查看。
6. 在本机临时配置 token 并发布：

~~~bash
export NODE_AUTH_TOKEN=npm_xxx
npm config set //registry.npmjs.org/:_authToken "$NODE_AUTH_TOKEN"
npm publish --registry=https://registry.npmjs.org
~~~

不要把 token 写入仓库。仓库已忽略 **.npmrc** 与 ***.tgz**。

> 注意：错误信息要求的是 **granular access token**，不是旧的 classic automation token。

## 11. 常见错误

| 错误 | 原因 | 处理 |
|------|------|------|
| ENEEDAUTH | 未登录或 token 失效 | npm login，或配置 Automation Token |
| E404 发布失败 | 发布命令指向了只读镜像 | 显式加 --registry=https://registry.npmjs.org |
| E403 名称被占用 | 包名已被他人注册 | 改用 scope 包名，或联系 npm 支持 |
| EOTP | 账号开启 2FA | 追加 --otp=验证码 |
| E403 需要 2FA | 账号未开启发布 2FA，或需要 granular token | 按第 10 节开启 2FA 或使用 Bypass 2FA token |
| EPUBLISHCONFLICT | 该版本已存在 | 提升 version 后重新发布 |
| 安装后找不到 hotwave | 全局 bin 目录不在 PATH | 检查 npm prefix -g 与 PATH |
| 安装后缺少 dist | 发布时未编译 | 确认 prepublishOnly 执行成功，或先 npm run build |
