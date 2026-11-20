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

## 10. 常见错误

| 错误 | 原因 | 处理 |
|------|------|------|
| ENEEDAUTH | 未登录或 token 失效 | npm login，或配置 Automation Token |
| E404 发布失败 | 发布命令指向了只读镜像 | 显式加 --registry=https://registry.npmjs.org |
| E403 名称被占用 | 包名已被他人注册 | 改用 scope 包名，或联系 npm 支持 |
| EOTP | 账号开启 2FA | 追加 --otp=验证码 |
| EPUBLISHCONFLICT | 该版本已存在 | 提升 version 后重新发布 |
| 安装后找不到 hotwave | 全局 bin 目录不在 PATH | 检查 npm prefix -g 与 PATH |
| 安装后缺少 dist | 发布时未编译 | 确认 prepublishOnly 执行成功，或先 npm run build |
