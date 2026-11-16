# Paseo 原生输入框底部插槽

这是供 Paseo 客户端开发者使用的源码补丁。它不修改已安装的 iOS / Android 应用，也不需要重启正在运行的 daemon。

基线：getpaseo/paseo `e7e1b44ec8836f7d71d6c26cfa37bb196bfee525`（main，0.16.0 开发版本）。

## 行为

在现有 `addComposerPill` 中增加可选 `placement: "track" | "footer"`。默认行为保持为输入框上方；`footer` 使用输入框下方的一行固定高度区域，并复用 Paseo 的主题、按钮生命周期、浮层和原生底部面板。长读数在窄屏截断，完整内容可点击查看。

Harness Stats 的「手机端位置」设置会随注册传入该字段。未包含补丁的旧客户端忽略该字段并继续放在上方。

## 应用补丁

在对应基线的 Paseo 源码目录中执行：

```sh
git apply --check /path/to/footer-placement.patch
git apply /path/to/footer-placement.patch
```

随后按 Paseo 的开发文档安装依赖、构建客户端并验证设备。仅更新 daemon 或插件不能改变旧版原生客户端的位置。

## 验证范围

- 按钮模型的 7 项测试通过，覆盖 footer 与 track 的区分、主机 / 工作区 / 代理作用域、标签原位更新和移除。
- 模型与 SDK 改动的定向 lint 通过。
- 已检查补丁无空白错误。
- **完整 app 类型检查和 iOS / Android 构建未完成，尚未通过真机验收。** 当前验证环境仅安装了定向测试依赖，没有安装完整 Expo / 原生工具链。请勿把源码补丁当作已发布客户端功能。

补丁涉及的 Paseo 源码遵循 Apache-2.0，许可证见本目录的 LICENSE。
