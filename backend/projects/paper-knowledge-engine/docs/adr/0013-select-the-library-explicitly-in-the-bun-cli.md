# 在 Bun CLI 中显式选择方向库

CLI 保持 `bun src/cli.ts` 作为唯一交互入口，并支持 `bun src/cli.ts --library <id>`。当前只有 FSD 时默认选择 `fsd`，菜单同时显示引擎身份和当前方向库；新增方向只增加方向配置和独立数据/Vault，不复制引擎代码或恢复 PowerShell 菜单外壳。
