/* handlers.js 路由表 */
/*
  内容: HTTP -> 处理器的分发, 实现都在 ./handlers/<域>.js
  依赖: 各域处理器 / common.js(基础设施与常量)
*/
// 规则: 一条路由一个 if; 新增处理器务必同步补上本文件的 import 与末尾 export
// (漏了 esbuild 不报错, 运行时才 ReferenceError, Cloudflare 回 1101)

import { handleRegister, handleLogin, handleLogout, handleMe, handleVerifyPassword, handleDeleteAccount, handleCancelDeletion } from './handlers/auth.js';
import { handleEmailVerifyStart, handleEmailRebindStart, handleEmailRebindVerify, handleEmailRebind, handleEmailRebindConfirm, handleEmailCode, handleEmailDiag, handleEmailConfirm, handleVerifyEmailSend, handleVerifyEmailCheck } from './handlers/email.js';
import { handlePasswordResetStart, handlePasswordSet, handlePasswordReset, handlePasswordChangeRequest, handleAdminApprovePassword } from './handlers/password.js';
import { handleGithubStart, handleGithubCallback } from './handlers/oauth.js';
import { handleTerminalAccess, handleTerminalIota, handleUpdateProfile, handleViewPermissions, handlePublicUser, handleListUsers, handleUsersExist, handleUsernameCheck, handleGeoReverse } from './handlers/profile.js';
import { handleListArticles, handleGetArticle, handleSaveArticle, handleDeleteArticle, handleMyArticles, handleListTags, handleCreateNarra, handleTerminalArticles } from './handlers/article.js';
import { handleListComments, handleCreateComment, handleDeleteComment } from './handlers/comment.js';
import { handleChatConversations, handleChatMedia, handleChatHistory, handleSendChat, handleChatRecall, handleEmojiList, handleEmojiUpload, handleEmojiDelete } from './handlers/chat.js';
import { handleListNotices, handleSendNotice, handleDeleteNotice, handleReadNotices, handleFollowState, handleToggleFollow } from './handlers/notice.js';
import { handleAvatarUpload, handleImageUpload } from './handlers/upload.js';
import { handleResourcePresign, handleResourceUpload, handleResourceDownload, handleResourceHash, handleResourceList, handleResourceDetail, handleResourceDelete, handleResourceGroup, handleResourceGuard, handleResourceAllowEdit, handleResourceMultipartInit, handleResourceMultipartParts, handleResourceMultipartSign, handleResourceMultipartComplete, handleResourceMultipartAbort, handleResourceLogDownload, handleStorageOverview } from './handlers/resource.js';
import { handleSiteFlagsGet, handleSiteFlagsSet, handleLangSuggest } from './handlers/site.js';
import { handleRekeyImages, handleAvatarDiag, handleMigrateAvatars, handlePurgeImages } from './handlers/oss-admin.js';
import { handleOssBuckets, handleOssDelete, handleOssList, handleOssFolder, handleOssUpload, handleOssMedia, handleOssFolders, handleOssDeleteFolder } from './handlers/oss.js';
import { handleBanUser, handleUnbanUser, handleDeleteUser, handleModerateArticle, handleAdminListRoles, handleAdminGrant, handleAdminRevoke, handleRemoveArticle, handleRemapUserId } from './handlers/admin.js';
import { handleD1Tables, handleD1Query, handleD1Stats } from './handlers/d1.js';
import { handleSitemap, handleStats, handleRain } from './handlers/pages.js';
import { handleTotpSetup, handleTotpEnable, handleTotpVerify, handleTotpCheck } from './handlers/totp.js';


// asyfunc 分发: 按 path 路由到各域处理器
async function handleApi(request, env, url, path, ctx) {
  /* 站点数据 */
  // 站级访问 + 站长看的 D1 用量 (要 request 才认得出站长)
  if (path === '/api/stats') {
    return handleStats(request, env);
  }
  // 首页下雨那块要的天气 (公开)
  if (path === '/api/rain' && request.method === 'GET') {
    return handleRain(request, env, url);
  }
  if (path === '/api/register' && request.method === 'POST') {
    return handleRegister(request, env, url);
  }
  if (path === '/api/login' && request.method === 'POST') {
    return handleLogin(request, env, url);
  }
  if (path === '/api/logout' && request.method === 'POST') {
    return handleLogout(request, env);
  }
  if (path === '/api/me') {
    return handleMe(request, env);
  }
  if (path === '/api/profile' && request.method === 'POST') {
    return handleUpdateProfile(request, env);
  }
  // 我手上的查看凭证 (文章 <secret='...'> 用; 游客一律空表)
  if (path === '/api/view-permissions' && request.method === 'GET') {
    return handleViewPermissions(request, env);
  }

  // 终端通行证: 秘钥在前端对过之后记一笔 (没有它下次还得敲)
  if (path === '/api/terminal/access' && request.method === 'POST') {
    return handleTerminalAccess(request, env);
  }
  /* Iota 那一关: GET 问解锁状态, POST 校验答案 (见 handlers/profile.js) */
  if (path === '/api/terminal/iota' && (request.method === 'POST' || request.method === 'GET')) {
    return handleTerminalIota(request, env);
  }
  // 终端世界里那两张文章卡片: 加载期一次把登记的叙述全拿走
  if (path === '/api/terminal/articles' && request.method === 'GET') {
    return handleTerminalArticles(request, env);
  }

  /* GitHub OAuth */
  // 登录 / 绑定
  if (path === '/api/auth/github') {
    return handleGithubStart(request, env, url);
  }
  if (path === '/api/auth/github/callback') {
    return handleGithubCallback(request, env, url);
  }

  /* 账号注销 */
  // 只打标记不真删, 至少留 7 天可撤销; 真删由 cron 或站长动手
  if (path === '/api/account/delete' && request.method === 'POST') {
    return handleDeleteAccount(request, env);
  }
  // 撤销注销申请
  if (path === '/api/account/cancel-deletion' && request.method === 'POST') {
    return handleCancelDeletion(request, env);
  }
  // 注销前先验密码 (多步确认第一步)
  if (path === '/api/account/verify' && request.method === 'POST') {
    return handleVerifyPassword(request, env);
  }

  /* 邮箱 */
  // 发验证信 / 换绑确认信 / 换绑第二步 / 注销验证码 / 邮件里的确认链接
  if (path === '/api/email/verify' && request.method === 'POST') {
    return handleEmailVerifyStart(request, env, url);
  }
  if (path === '/api/email/unbind' && request.method === 'POST') {
    return handleEmailRebindStart(request, env, url);
  }
  // 旧邮箱的 6 位码 → 通行证
  if (path === '/api/email/unbind/verify' && request.method === 'POST') {
    return handleEmailRebindVerify(request, env);
  }
  if (path === '/api/email/rebind' && request.method === 'POST') {
    return handleEmailRebind(request, env);
  }
  // 换绑第三步: 新邮箱的 6 位码填对才真换
  if (path === '/api/email/rebind/confirm' && request.method === 'POST') {
    return handleEmailRebindConfirm(request, env);
  }
  if (path === '/api/email/code' && request.method === 'POST') {
    return handleEmailCode(request, env);
  }
  // 「验证身份」弹窗的邮箱那条: 下发 / 校验 6 位码
  if (path === '/api/verify/email/send' && request.method === 'POST') {
    return handleVerifyEmailSend(request, env);
  }
  if (path === '/api/verify/email/check' && request.method === 'POST') {
    return handleVerifyEmailCheck(request, env);
  }
  if (path === '/api/email/confirm') {
    return handleEmailConfirm(request, env, url);
  }
  // 站长自查: 发信配没配 / Resend 域名验没验过
  if (path === '/api/email/diag') {
    return handleEmailDiag(request, env);
  }

  /* 文章 评论 标签 */
  if (path === '/api/articles' && request.method === 'GET') {
    return handleListArticles(request, env, url);
  }
  if (path === '/api/article' && request.method === 'GET') {
    return handleGetArticle(request, env, url);
  }
  if (path === '/api/articles' && request.method === 'POST') {
    return handleSaveArticle(request, env, ctx);
  }
  if (path === '/api/articles/delete' && request.method === 'POST') {
    return handleDeleteArticle(request, env, ctx);
  }
  // 新建叙述 (站长): 建一篇空叙述 + 当场占住引用键名
  if (path === '/api/articles/narra' && request.method === 'POST') {
    return handleCreateNarra(request, env);
  }
  if (path === '/api/user' && request.method === 'GET') {
    return handlePublicUser(request, env, url);
  }
  if (path === '/api/my/articles' && request.method === 'GET') {
    return handleMyArticles(request, env);
  }
  if (path === '/api/tags' && request.method === 'GET') {
    return handleListTags(env);
  }
  // 文章正文下面那一块: 读公开, 发 / 删要登录
  if (path === '/api/comments' && request.method === 'GET') {
    return handleListComments(request, env, url);
  }
  if (path === '/api/comments' && request.method === 'POST') {
    return handleCreateComment(request, env);
  }
  if (path === '/api/comments/delete' && request.method === 'POST') {
    return handleDeleteComment(request, env);
  }
  // 只有「删除」一条路; 「撤回评论」已整体删掉, 别再恢复 (前端按钮与 can_recall 字段也清了)

  /* 用户目录 */
  // 「连携星点」
  if (path === '/api/users' && request.method === 'GET') {
    return handleListUsers(request, env, url);
  }
  // 正文里 @提及 用到的用户名一次问完 (公开: 文章页没登录也要能上色)
  if (path === '/api/users/exists' && request.method === 'GET') {
    return handleUsersExist(env, url);
  }
  // 注册页的「这个用户名还能用吗」(本地规则过了再问一句, 公开接口)
  if (path === '/api/username/check' && request.method === 'GET') {
    return handleUsernameCheck(env, url);
  }

  /* 站内信 */
  // 系统通知 + 用户互发
  if (path === '/api/notices' && request.method === 'GET') {
    return handleListNotices(request, env);
  }
  if (path === '/api/notices/read' && request.method === 'POST') {
    return handleReadNotices(request, env);
  }
  // 删掉一条自己的站内信 (卡片右边的小垃圾桶)
  if (path === '/api/notices/delete' && request.method === 'POST') {
    return handleDeleteNotice(request, env);
  }
  // 用户之间互发 (以前只有系统通知)
  if (path === '/api/notices/send' && request.method === 'POST') {
    return handleSendNotice(request, env);
  }

  /* 关注 */
  // 追随者
  if (path === '/api/follow' && request.method === 'GET') {
    return handleFollowState(request, env, url);
  }
  if (path === '/api/follow' && request.method === 'POST') {
    return handleToggleFollow(request, env);
  }

  /* 私聊 */
  // 宿主: 个人页的私信弹窗 / 手机端的独立私信页
  if (path === '/api/chat' && request.method === 'GET') {
    return handleChatHistory(request, env, url);
  }
  if (path === '/api/chat' && request.method === 'POST') {
    return handleSendChat(request, env);
  }
  if (path === '/api/chat/conversations' && request.method === 'GET') {
    return handleChatConversations(request, env);
  }
  // 撤回 (5 分钟内, 双方记录都消失) + 「另存为」用的图片代理
  if (path === '/api/chat/recall' && request.method === 'POST') {
    return handleChatRecall(request, env);
  }
  if (path === '/api/chat/media' && request.method === 'GET') {
    return handleChatMedia(request, env, url);
  }
  /* 表情包 */
  // 存在 foraine-image 的 img/<用户名>/emoji/ 下, 登记在 emoji 表
  if (path === '/api/emoji' && request.method === 'GET') {
    return handleEmojiList(request, env);
  }
  if (path === '/api/emoji' && request.method === 'POST') {
    return handleEmojiUpload(request, env);
  }
  if (path === '/api/emoji/delete' && request.method === 'POST') {
    return handleEmojiDelete(request, env);
  }

  /* 动态令牌 (TOTP) */
  // 生成二维码 / 确认启用
  if (path === '/api/totp/setup' && request.method === 'POST') {
    return handleTotpSetup(request, env);
  }
  if (path === '/api/totp/enable' && request.method === 'POST') {
    return handleTotpEnable(request, env);
  }
  // 「验证身份」弹窗选「令牌」时走这条: 只校验, 不改状态
  if (path === '/api/totp/verify' && request.method === 'POST') {
    return handleTotpVerify(request, env);
  }
  // 绑定流程同样只验不改: 输入码先验一次, 通过后前端才让点确认
  if (path === '/api/totp/check' && request.method === 'POST') {
    return handleTotpCheck(request, env);
  }

  /* 密码重置 */
  // 自助邮件 / 托站长两条路
  if (path === '/api/password/reset/start' && request.method === 'POST') {
    return handlePasswordResetStart(request, env, url);
  }
  if (path === '/api/password/reset' && request.method === 'POST') {
    return handlePasswordReset(request, env, url);
  }
  // 验证身份后直接设新密码 (凭「验证身份」的通行证)
  if (path === '/api/password/set' && request.method === 'POST') {
    return handlePasswordSet(request, env, url);
  }
  if (path === '/api/password/request' && request.method === 'POST') {
    return handlePasswordChangeRequest(request, env);
  }
  if (path === '/api/admin/password/approve' && request.method === 'POST') {
    return handleAdminApprovePassword(request, env);
  }

  /* 头像 */
  // 阿里云 OSS
  if (path === '/api/avatar' && request.method === 'POST') {
    return handleAvatarUpload(request, env);
  }
  if (path === '/api/avatar/diag' && request.method === 'GET') {
    return handleAvatarDiag(request, env, url);
  }

  /* 上传 */
  // 配图与资源都走 OSS 签名, 两个桶: foraine-image 与 foraine-resource
  if (path === '/api/image' && request.method === 'POST') {
    return handleImageUpload(request, env);
  }
  // 资源桶 (res.foraine.xyz): 先登记再上传
  if (path === '/api/resource/upload' && request.method === 'POST') {
    return handleResourceUpload(request, env);
  }
  // 直传: 只签名 + 登记, 字节由浏览器 PUT 给 OSS
  if (path === '/api/resource/presign' && request.method === 'POST') {
    return handleResourcePresign(request, env);
  }
  // 下载 (Worker 代取 + 强制 attachment, 桶私有读也能下)
  if (path === '/api/resource/download' && request.method === 'GET') {
    return handleResourceDownload(request, env, url);
  }
  // 补服务端校验值: 直传那条 Worker 拿不到 ETag, 传完客户端再叫一下
  if (path === '/api/resource/hash' && request.method === 'POST') {
    return handleResourceHash(request, env);
  }
  /* 资源中心 */
  // 列表与详情公开, 删除要权限
  // 列表只挑 scope='library': 表里混着私聊附件, 绝不能直接查全表
  if (path === '/api/resources' && request.method === 'GET') {
    return handleResourceList(request, env, url);
  }
  if (path === '/api/resource/detail' && request.method === 'GET') {
    return handleResourceDetail(request, env, url);
  }
  if (path === '/api/resource/delete' && request.method === 'POST') {
    return handleResourceDelete(request, env);
  }
  // 改组的信息 (标题 / 简介 / 有效期); 单文件与整组共用
  if (path === '/api/resource/group' && request.method === 'POST') {
    return handleResourceGroup(request, env);
  }
  // 防盗开关 (对象设私有 + 只认站内 Referer); 单文件与整组共用
  if (path === '/api/resource/guard' && request.method === 'POST') {
    return handleResourceGuard(request, env);
  }
  // 「公开编辑」开关 (详情页右栏那块面板)
  if (path === '/api/resource/allow-edit' && request.method === 'POST') {
    return handleResourceAllowEdit(request, env);
  }
  // 直链下载上报: 直链字节不过 Worker, 只能前端补一条
  if (path === '/api/resource/log-download' && request.method === 'POST') {
    return handleResourceLogDownload(request, env);
  }
  // 站长看的存储概览 (四张数字卡)
  if (path === '/api/storage/overview' && request.method === 'GET') {
    return handleStorageOverview(request, env);
  }
  /* 站点级开关 */
  // 站长个人页「Foraine」页签: 下行流量方案 / 资源量限制方案
  if (path === '/api/site/flags') {
    if (request.method === 'GET') return handleSiteFlagsGet(request, env);
    if (request.method === 'POST') return handleSiteFlagsSet(request, env);
  }
  /* 分片上传 */
  // 断点续传, 只有大文件走: 浏览器只 PUT 分片, 其余都在 Worker
  if (path === '/api/resource/multipart/init' && request.method === 'POST') {
    return handleResourceMultipartInit(request, env);
  }
  if (path === '/api/resource/multipart/list' && request.method === 'POST') {
    return handleResourceMultipartParts(request, env);
  }
  if (path === '/api/resource/multipart/sign' && request.method === 'POST') {
    return handleResourceMultipartSign(request, env);
  }
  if (path === '/api/resource/multipart/complete' && request.method === 'POST') {
    return handleResourceMultipartComplete(request, env);
  }
  if (path === '/api/resource/multipart/abort' && request.method === 'POST') {
    return handleResourceMultipartAbort(request, env);
  }
  /* 定位 */
  // 位置栏的「定位」: 经纬度 -> 英文地址 (转 Nominatim)
  if (path === '/api/geo/reverse' && request.method === 'GET') {
    return handleGeoReverse(request, env, url);
  }
  /* 站长工具 */
  // 把 img/unsorted/ 搬进某篇文章的文件夹 (顺手改引用)
  if (path === '/api/admin/oss/rekey' && request.method === 'POST') {
    return handleRekeyImages(request, env);
  }

  /* 审核与封禁 */
  // 审核删文 / 封禁 / 解封
  if (path === '/api/moderation/article' && request.method === 'POST') {
    return handleModerateArticle(request, env, ctx);
  }
  // 站长的「真删」(审核下架之外那一手)
  if (path === '/api/moderation/remove' && request.method === 'POST') {
    return handleRemoveArticle(request, env, ctx);
  }
  if (path === '/api/moderation/ban' && request.method === 'POST') {
    return handleBanUser(request, env);
  }
  if (path === '/api/moderation/unban' && request.method === 'POST') {
    return handleUnbanUser(request, env);
  }
  // 删号 (仅站长)
  if (path === '/api/admin/user/delete' && request.method === 'POST') {
    return handleDeleteUser(request, env);
  }
  // 头像迁移 (仅站长): 旧桶头像搬进配图桶的 avatar/ 前缀
  if (path === '/api/admin/oss/migrate-avatars' && request.method === 'POST') {
    return handleMigrateAvatars(request, env);
  }
  // 旧 img/ 布局清理 (仅站长): 删掉不属于 img/article/ 与 img/user/ 的对象
  if (path === '/api/admin/oss/purge-images' && request.method === 'POST') {
    return handlePurgeImages(request, env);
  }
  /* OSS 控制台 */
  // 站长「OSS」页签: 两个桶的卡片 + 列对象 + 删对象
  if (path === '/api/admin/oss/buckets' && request.method === 'GET') {
    return handleOssBuckets(request, env);
  }
  if (path === '/api/admin/oss/list' && request.method === 'GET') {
    return handleOssList(request, env, url);
  }
  if (path === '/api/admin/oss/delete' && request.method === 'POST') {
    return handleOssDelete(request, env);
  }
  // 站长往桶里手放东西: 建文件夹 / 上传 / 代下
  if (path === '/api/admin/oss/folder' && request.method === 'POST') {
    return handleOssFolder(request, env);
  }
  // 文件夹的体积 / 个数 (单独拉, 不拖慢主列表) 与递归删除 (一批一批地删)
  if (path === '/api/admin/oss/folders' && request.method === 'GET') {
    return handleOssFolders(request, env, url);
  }
  if (path === '/api/admin/oss/delete-folder' && request.method === 'POST') {
    return handleOssDeleteFolder(request, env);
  }
  if (path === '/api/admin/oss/upload' && request.method === 'POST') {
    return handleOssUpload(request, env);
  }
  if (path === '/api/admin/oss/media' && request.method === 'GET') {
    return handleOssMedia(request, env, url);
  }

  /* RBAC 与 D1 控制台 */
  // 管理员 (RBAC)
  if (path === '/api/admin/roles' && request.method === 'GET') {
    return handleAdminListRoles(request, env);
  }
  // D1 控制台 (仅站长): 表清单 + 只读查询
  if (path === '/api/admin/d1/tables' && request.method === 'GET') {
    return handleD1Tables(request, env);
  }
  if (path === '/api/admin/d1/query' && request.method === 'POST') {
    return handleD1Query(request, env);
  }
  // 一次性工具: 改某个用户的 id (所有引用一起搬)
  if (path === '/api/admin/user/remap-id' && request.method === 'POST') {
    return handleRemapUserId(request, env);
  }
  if (path === '/api/admin/grant' && request.method === 'POST') {
    return handleAdminGrant(request, env);
  }
  if (path === '/api/admin/revoke' && request.method === 'POST') {
    return handleAdminRevoke(request, env);
  }

  if (path === '/api/admin/d1/stats' && request.method === 'GET') {
    return handleD1Stats(request, env, url);
  }

  // 语言建议: 按访客 IP 猜一门语言 (前端兜底, 也用来查看 IP 的国家判定)
  if (path === '/api/lang' && request.method === 'GET') {
    return handleLangSuggest(request, env);
  }

  return Response.json({ error: 'Not Found' }, { status: 404 });
}


export { handleRegister, handleLogin, handleLogout, handleMe, handleVerifyPassword, handleDeleteAccount, handleCancelDeletion, handleEmailVerifyStart, handleEmailRebindStart, handleEmailRebind, handleEmailRebindConfirm, handleEmailCode, handleEmailDiag, handleEmailConfirm, handlePasswordResetStart, handlePasswordReset, handlePasswordChangeRequest, handleAdminApprovePassword, handleGithubStart, handleGithubCallback, handleUpdateProfile, handlePublicUser, handleListUsers, handleUsersExist, handleUsernameCheck, handleGeoReverse, handleListArticles, handleGetArticle, handleSaveArticle, handleDeleteArticle, handleMyArticles, handleListTags, handleCreateNarra, handleTerminalArticles, handleListComments, handleCreateComment, handleDeleteComment, handleChatConversations, handleChatMedia, handleChatHistory, handleSendChat, handleChatRecall, handleEmojiList, handleEmojiUpload, handleEmojiDelete, handleListNotices, handleSendNotice, handleDeleteNotice, handleReadNotices, handleFollowState, handleToggleFollow, handleAvatarUpload, handleImageUpload, handleResourcePresign, handleResourceUpload, handleResourceDownload, handleResourceHash, handleResourceList, handleResourceDetail, handleResourceDelete, handleResourceGroup, handleResourceGuard, handleRekeyImages, handleAvatarDiag, handleMigrateAvatars, handlePurgeImages, handleOssBuckets, handleOssList, handleOssDelete, handleOssFolders, handleOssDeleteFolder, handleBanUser, handleUnbanUser, handleDeleteUser, handleModerateArticle, handleAdminListRoles, handleAdminGrant, handleAdminRevoke, handleD1Tables, handleD1Query, handleD1Stats, handleTotpSetup, handleTotpEnable, handleSitemap, handleStats, handleRain, handleLangSuggest, handleApi };
