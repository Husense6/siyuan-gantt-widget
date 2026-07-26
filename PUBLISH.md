# 发布到思源集市

## 1. 创建 GitHub 仓库

在 GitHub 创建公开仓库：

- 仓库名：`siyuan-gantt-widget`
- 地址：`https://github.com/Husense6/siyuan-gantt-widget`
- 默认分支：`main`

将本目录中的源码文件提交到仓库。`package.zip` 已被 `.gitignore` 排除，不需要提交到 Git。

## 2. 创建 GitHub Release

在仓库的 Releases 页面创建新 Release：

- Tag：`v0.12.7`
- 标题：`v0.12.7`
- 附件：本目录中的 `package.zip`
- 发布后确认它是 Latest Release

`package.zip` 中的文件已经位于 ZIP 根目录，可直接作为思源集市 Release 附件。

## 3. 提交集市 PR

1. Fork `https://github.com/siyuan-note/bazaar`。
2. 在 Fork 仓库根目录的 `widgets.txt` 新增一行：

   ```text
   Husense6/siyuan-gantt-widget
   ```

3. 只提交这一项修改。
4. 创建 Pull Request 到 `siyuan-note/bazaar` 的 `main` 分支。
5. 根据 PR Check 的提示处理检查结果，等待审核和合并。

## 后续更新

1. 修改 `widget.json` 中的 `version`。
2. 重新生成根目录结构的 `package.zip`。
3. 创建对应的新 GitHub Release 并上传 `package.zip`。

后续版本无需再次修改 `widgets.txt` 或提交新的集市 PR。
