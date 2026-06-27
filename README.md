# mooc-manus-all

智能体编排平台 - 前后端统一管理仓库

## 仓库结构

- `mooc-manus/` - 后端服务 (Go)
- `mooc-manus-web/` - 前端应用 (React + TypeScript)

## 快速开始

### 克隆仓库(含子仓库)

```bash
git clone --recursive <总仓库URL>
```

### 启动后端

```bash
cd mooc-manus
# 参考后端 README
```

### 启动前端

```bash
cd mooc-manus-web
npm install --legacy-peer-deps
npm run dev
```

## 子仓库管理

详见各子仓库 README。

⚠️ **提交规范:** 先推送子仓库,再推送总仓库引用。
