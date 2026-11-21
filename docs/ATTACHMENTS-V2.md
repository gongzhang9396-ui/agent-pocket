# Host attachments-v2

Host 新增 `attachments-v2`，旧内联 `images/files` 和 `attachments-v1` 保持兼容。Relay 只转发现有加密 RPC 密文，不提供公开文件上传地址。

## 上传流程

1. 客户端为一次发送生成 UUID operationId；每个附件生成 slot UUID 和至少 32 字节随机 token，并持久保存草稿。
2. `attachment/begin`：传 operationId、slot、token、filename、mimeType、size、sha256 和目标 `threadId` 或 `cwd`。同设备、operationId、slot、内容、token 及目标的重复 begin 返回原上传状态。
3. `attachment/write`：传 id、token、offset、标准 base64 data。每块最多 192 KiB，顺序追加；重复块须完全相同，拒绝缺口及与已写内容部分重叠的追加。
4. 断线后 `attachment/status` 取 offset，再继续。Host 重启可从磁盘恢复；不存在的上传返回 NOT_FOUND，客户端可重新 begin。
5. `attachment/finish` 校验完整长度与 SHA-256，并标记 ready。
6. `thread/start`、`turn/start` 或 `turn/steer` 传同一 operationId 和 `attachmentIds: [{id, token}]`。Host 校验设备、目标、操作绑定与文件身份，再提交给执行器。任务创建后绑定新 threadId。
7. 未提交上传可 `attachment/abort`；已提交附件拒绝撤销。客户端停止传输保留草稿，可续传；移除附件显式 abort，并删除客户端自己的副本。

每次最多 3 个附件，单个 20 MiB，合计 60 MiB。设备暂存配额 120 MiB、全局 1 GiB；另有目录数量上限。文件流式写入专用临时目录，元数据不保存明文 token，只保存其摘要。普通文件、专用根标识、非符号链接、非硬链接、规范路径及文件变化检查均在 Host 端实施。图片只支持 JPEG/PNG/WebP；文本/代码和 PDF 沿用显式扩展名/MIME 白名单。

未提交上传闲置一小时清理。已提交附件须确认任务结束一小时后才能清理；活动任务、未知状态任务或未知操作仍保留引用。不能为了腾空间删除无法确认状态的引用，达到配额后明确失败。清理仅删除本模块可识别的文件/目录，不递归删除任意内容。

## 发送回执

附件上传不创建任务 mutation journal。只有准备完成、即将发送任务请求时才落 operationId 记录。若发送结果未知，客户端只查 `operation/get`；missing/pending/unknown 都不能当作失败，更不能再创建任务。确定未发出或电脑返回 failed 回执后才允许新操作；成功回执可恢复原结果。

返回文件继续用 `artifact/list` / `artifact/read`，上限 32 MiB，按授权设备、任务及文件身份读取。上传 ID 和返回文件授权不能互换。
