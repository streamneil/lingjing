# 灵镜 Slice 1 — app 镜像。
# better-sqlite3 是原生模块,用完整 node 镜像(含构建工具链)避免编译问题。

FROM node:22-slim AS base
WORKDIR /app

# 原生模块编译依赖
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm install --omit=dev || npm install

COPY . .

EXPOSE 9372
# tsx 直接跑 TS,Slice1 不预编译(规模化后改 npm run build + node dist)
CMD ["npm", "run", "start"]
