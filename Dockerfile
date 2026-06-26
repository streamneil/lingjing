# 灵镜 app 镜像。
# better-sqlite3 是原生模块,用完整 node 镜像(含构建工具链)避免编译问题。
# ffmpeg/ffprobe:AI 合规标识、音频时长校验、长视频分段拼接需要(缺则静默降级)。

FROM node:22-slim AS base
WORKDIR /app

# 中国大陆构建提速:apt 换阿里云镜像、npm 换 npmmirror。
# 海外/官方源构建用 --build-arg APT_MIRROR=deb.debian.org NPM_REGISTRY=https://registry.npmjs.org 覆盖。
# 阿里云 ECS 内网更快(不耗公网带宽):--build-arg APT_MIRROR=mirrors.cloud.aliyuncs.com
ARG APT_MIRROR=mirrors.aliyun.com
ARG NPM_REGISTRY=https://registry.npmmirror.com

# 原生模块编译依赖 + ffmpeg(含 ffprobe)。先换 apt 源(bookworm 兼容 deb822 与旧 sources.list)再装。
RUN set -eux; \
  for f in /etc/apt/sources.list /etc/apt/sources.list.d/debian.sources; do \
    if [ -f "$f" ]; then sed -i "s|deb.debian.org|${APT_MIRROR}|g; s|security.debian.org|${APT_MIRROR}|g" "$f"; fi; \
  done; \
  apt-get update; \
  apt-get install -y python3 make g++ ffmpeg; \
  rm -rf /var/lib/apt/lists/*

# better-sqlite3 原生模块:强制源码编译(已装 python3/make/g++),避免从 GitHub 拉预编译二进制在国内卡住。
ENV npm_config_build_from_source=true

# 先拷 lock + package.json,npm ci 走缓存层。
# npm ci:确定性安装(严格按 lock)。--omit=dev 排 vitest/typescript 等 devDeps;
# tsx 已移到 dependencies(start 用 node --import tsx),不会被排掉。
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --registry="${NPM_REGISTRY}"

COPY . .

# 数据卷目录归 node 用户,然后降权到非 root 跑(最小权限,容器逃逸不是 root)。
# SQLite 主库 + WAL + shm 都由 node 进程创建,属主一致。
RUN mkdir -p /data && chown -R node:node /data /app
USER node

EXPOSE 9372
# tsx 直接跑 TS,Slice1 不预编译(规模化后改 npm run build + node dist)
CMD ["npm", "run", "start"]
