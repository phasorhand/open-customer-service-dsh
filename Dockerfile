# OpenCS-DSH 运行镜像
#
# 注意：本项目通过 pnpm `link:` 依赖本地 checkout 的 deepseek-harness（见 README）。
# 因此构建上下文必须是**两个仓库的共同父目录**：
#   docker build -f open-customer-service-dsh/Dockerfile -t opencs-dsh .
FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable

WORKDIR /workspace

# dsh 以 link: 引用，必须一同拷入且保留相对路径
COPY deepseek-harness/package.json ./deepseek-harness/package.json
COPY deepseek-harness/vendor ./deepseek-harness/vendor
COPY deepseek-harness/packages ./deepseek-harness/packages

WORKDIR /workspace/app
COPY open-customer-service-dsh/package.json open-customer-service-dsh/pnpm-lock.yaml open-customer-service-dsh/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod=false

COPY open-customer-service-dsh/ ./

# 运行期数据目录；生产请挂卷，否则容器重建会丢联系人与会话
ENV OPENCS_DATA_DIR=/data \
    OPENCS_KNOWLEDGE_DIR=/workspace/app/knowledge \
    OPENCS_SKILLS_DIR=/workspace/app/skills \
    OPENCS_HOST=0.0.0.0 \
    OPENCS_PORT=8080
RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:8080/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["pnpm", "start"]
