# 灵镜 app 镜像。
# better-sqlite3 是原生模块,用完整 node 镜像(含构建工具链)避免编译问题。
# ffmpeg/ffprobe:AI 合规标识、音频时长校验、长视频分段拼接需要(缺则静默降级)。

FROM node:22-slim AS base
WORKDIR /app

# 原生模块编译依赖 + ffmpeg(含 ffprobe)。同一 RUN 减少层。
RUN apt-get update \
  && apt-get install -y python3 make g++ ffmpeg \
  && rm -rf /var/lib/apt/lists/*

# 先拷 lock + package.json,npm ci 走缓存层。
# npm ci:确定性安装(严格按 lock)。--omit=dev 排 vitest/typescript 等 devDeps;
# tsx 已移到 dependencies(start 用 node --import tsx),不会被排掉。
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# 数据卷目录归 node 用户,然后降权到非 root 跑(最小权限,容器逃逸不是 root)。
# SQLite 主库 + WAL + shm 都由 node 进程创建,属主一致。
RUN mkdir -p /data && chown -R node:node /data /app
USER node

EXPOSE 9372
# tsx 直接跑 TS,Slice1 不预编译(规模化后改 npm run build + node dist)
CMD ["npm", "run", "start"]
