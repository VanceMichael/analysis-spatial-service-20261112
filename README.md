# spatial-service

visitors/served 为人数，x/y 为本地演练坐标，不对应真实人员位置。

项目目前提供本地记录校验、输入指纹和按 `district` 的原始核算。分析人员可以保留完整输入并复查每次导出的 JSON；原始数据不被命令改写。业务配置位于 `data/policy.json`，字段约定在 `docs/data.md`。

## 运行

使用 Node.js 22 LTS（>=22.22.1 且 <23）和 npm，无第三方运行依赖。
`.nvmrc` 选择 22 主版本，清单与锁文件记录相同的兼容范围；Dockerfile 仍固定基础镜像摘要，容器构建可精确复现。

```sh
npm ci --ignore-scripts --no-audit --no-fund --offline
npm run build
npm test
npm run summary
npm run cluster
node src/cli.js inspect --input data/records.json
node src/cli.js summary --input data/records.json --out var/summary.json
node src/cli.js cluster --config data/cluster.config.json --out var/cluster.json
npm run demo
```

`npm run demo` 在本地打印输入、现有核算、业务配置与一次空间集聚分析并生成 `var/summary.json`、`var/cluster.json`，不访问网络、不等待真实业务时间，通常几秒内完成。输出目录可删除后重新运行，测试只使用临时目录。

### 空间集聚分析

`cluster` 命令基于本地格网邻接表构建空间权重（行标准化或原始边权，质检自邻接、重复边、不对称与孤岛），对显式声明的指标（`count` 服务次数 / `rate` 服务率 / `gap` 需求缺口；零访问量格网不按零服务率纳入）计算全局 Moran's I 与局部 HH/LL/HL/LH 集聚类型。显著性由条件置换估计：局部检验固定焦点单元、逐焦点独立置换，支持全市与区县内两种置换范围；岛状格网与有效邻居不足显示无法估计。多邻接半径、多置换范围与全部单元的检验完整登记并做敏感性比较，输出 JSON（stdout/落盘）与简洁中文区域摘要（stderr），只提示走访方向，不下资源不足的因果结论。口径与字段细节见 `docs/data.md`。

## 容器

```sh
docker build -t spatial-service:local .
docker run --rm --network none spatial-service:local
```

Dockerfile 固定 Node.js 基础镜像摘要，构建时执行语法检查和测试。镜像构建完成后演示无需联网；可覆盖命令运行 `npm test`。构建不需要真实账号、邮件服务、数据库或线上数据。

## 目录

- `src/dataset.js`：记录校验、规范序列化和数据指纹。
- `src/domain.js`：当前业务分组核算。
- `src/weights.js`：邻接表质检、权重矩阵、行标准化、半径派生与样本裁剪。
- `src/indicators.js`：服务次数/服务率/需求缺口口径与零访问量处理。
- `src/random.js`：确定性随机流、洗牌与精确排列枚举。
- `src/moran.js`：全局/局部 Moran's I、条件置换检验与多重比较校正。
- `src/spatial.js`：多半径、多置换范围的分析编排与敏感性比较。
- `src/report.js`：简洁中文区域摘要。
- `src/clusterConfig.js`：集聚分析配置加载与校验。
- `src/cli.js`：本地读取、检查和导出入口。
- `src/output.js`：以临时文件写入后替换完整 JSON。
- `test/`：输入约束、领域核对、权重质检、统计数值、置换与命令回归。
- `data/`：合成记录、独立核对值、本地业务配置与集聚分析配置。
