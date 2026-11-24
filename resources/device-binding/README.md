# 设备资料工具

`copy_device_info_1.2.apk` 沿用 Lotus-ReFactor 的同一份附件。SHA-256 为 `a3613eee47a2f3dfea9623e79724faec3f36d3efa9c3d3bfc5d7e988aebe2ed7`。 [原附件](https://github.com/MOPELotus/Lotus-ReFactor/blob/29f040c9021462eebf6ed74a9bd9a383c61b7039/resources/apk/copy_device_info_1.2.apk)

用户在机器人好友私聊发送 `#绑定设备` 后，机器人会发送可用的 APK 附件。APK 导出完整安卓参数（含 OAID）时，机器人会生成缺失的设备 ID，向米游社申请设备指纹后绑定；已有配对的 `device_id` 和 `device_fp` 也可直接发送。申请期间取消、断线或更换账号会停止绑定，申请失败不会保存种子或半成品设备。档案号可以跟在指令后面，例如 `#绑定设备2`。

部署时可通过 `LOTUS_DEVICE_INFO_APK` 指定本地工具路径。协议端文件发送不可用时，机器人会提供原附件的下载地址。
