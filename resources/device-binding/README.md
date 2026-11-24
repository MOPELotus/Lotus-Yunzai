# 设备资料工具

`copy_device_info_1.2.apk` 沿用 Lotus-ReFactor 的同一份附件。SHA-256 为 `a3613eee47a2f3dfea9623e79724faec3f36d3efa9c3d3bfc5d7e988aebe2ed7`。 [原附件](https://github.com/MOPELotus/Lotus-ReFactor/blob/29f040c9021462eebf6ed74a9bd9a383c61b7039/resources/apk/copy_device_info_1.2.apk)

用户在机器人好友私聊发送 `#绑定设备` 后，机器人会发送可用的 APK 附件。旧工具导出只有安卓参数时，绑定还需同一设备的 `device_id` 和已签发的 `device_fp`。档案号可以跟在指令后面，例如 `#绑定设备2`。

部署时可通过 `LOTUS_DEVICE_INFO_APK` 指定本地工具路径。协议端文件发送不可用时，机器人会提供原附件的下载地址。
