import 'package:sodium/sodium_sumo.dart';
import 'dart:async';
import 'dart:io';
import '../protocol/relay_hosts.dart';
import '../tasks/host_catalog_loader.dart';
import '../tasks/thread_page.dart';
import '../tasks/operation_runner.dart';
import '../tasks/android_operation_journal.dart';
import '../tasks/attachment_uploader.dart';
import 'dart:convert';
import '../protocol/relay_account_crypto.dart';
import '../protocol/relay_event_feed.dart';
import '../protocol/android_feed_cursor_store.dart';
import 'device_enrollment.dart';
import 'android_enrollment_store.dart';
import 'relay_http.dart';
import 'background_connection.dart';
import 'account_devices.dart';
import '../protocol/rpc_client.dart';
import 'package:crypto/crypto.dart';
import '../tasks/native_files.dart';
import 'android_credential_store.dart';
import 'existing_device_login.dart';
import 'existing_device_login_crypto.dart';
import 'pending_device_approval.dart';
import 'relay_token_refresh.dart';
import 'session_manager.dart';

class HostDirectory {
  const HostDirectory(this.session, this.hosts);
  final SessionRef session;
  final List<RelayHost> hosts;
}

/// Pages and background work share one credential store and refresh coordinator.
class PocketSessionService {
  PocketSessionService._(this.sodium, this.sessions)
      : login = existingDeviceLogin(sodium, sessions),
        approval = pendingDeviceApproval(sodium, sessions),
        hosts = RelayHosts(sessions),
        catalog = HostCatalogLoader(sodium, sessions);
  final operations = OperationRunner(AndroidOperationJournal());
  final Set<String> _activeOperations = {};
  late final feed = RelayEventFeed(sessions, AndroidFeedCursorStore(), RelayAccountCrypto(sodium).decryptAccountEnvelope);
  late final enrollment = DeviceEnrollment(RelayAccountCrypto(sodium), sessions, AndroidEnrollmentStore(), RelayHttp());
  late final background = BackgroundConnection(this);
  late final accountDevices = AccountDevices(sessions, RelayAccountCrypto(sodium));
  final SodiumSumo sodium;
  final SessionManager sessions;
  final ExistingDeviceLogin login;
  final PendingDeviceApproval approval;
  final RelayHosts hosts;
  final HostCatalogLoader catalog;
  static Future<PocketSessionService>? _shared;

  static Future<PocketSessionService> shared() => _shared ??= _create();
  static Future<PocketSessionService> _create() async {
    final sodium = await SodiumSumoInit.init();
    final store = AndroidCredentialStore();
    final sessions = SessionManager(store, RelayTokenRefresh().call);
    return PocketSessionService._(sodium, sessions);
  }

  Future<Map<String, dynamic>> loginExisting(String password) => login.login(password);
  Future<void> changePassword(String current, String replacement) async {
    if (replacement.length < 12 || replacement.length > 128) throw const FormatException('新密码须为 12 到 128 位');
    final ref = await sessions.snapshot();
    final credentials = await sessions.fresh(ref);
    if (!sessions.isCurrent(ref)) throw SessionChanged();
    await RelayHttp().json(credentials['endpoint'] as String, '/api/account/password', method: 'POST', token: credentials['accessToken'] as String,
      body: {'currentPassword': current, 'newPassword': replacement}, stillCurrent: () => sessions.isCurrent(ref));
    if (!sessions.isCurrent(ref)) throw SessionChanged();
  }
  Future<void> forgetDevice() async {
    final previous = await sessions.store.load();
    await sessions.clear(); await background.stop(); await feed.forget();
    await AndroidEnrollmentStore().save({});
    await AndroidCredentialStore.clearPendingHost();
    if (previous != null && previous['endpoint'] is String && previous['accessToken'] is String) {
      unawaited(RelayHttp().json(previous['endpoint'] as String, '/api/auth/logout', method: 'POST', token: previous['accessToken'] as String,
        body: {'refreshToken': previous['refreshToken']}).catchError((Object _) => <String, dynamic>{}));
    }
  }

  Future<bool> checkPendingDevice() async {
    final session = await sessions.snapshot(approvedOnly: false);
    return approval.poll(session);
  }

  Future<HostDirectory> listHosts() async {
    final session = await sessions.snapshot();
    return HostDirectory(session, await hosts.list(session));
  }

  Future<List<Map<String, dynamic>>> listTasks(HostDirectory directory, RelayHost host) {
    if (!directory.hosts.contains(host)) throw ArgumentError('电脑不属于当前列表');
    return catalog.load(directory.session, host);
  }

  Future<Map<String, dynamic>> readTask(HostDirectory directory, RelayHost host, String threadId, {String? cursor}) {
    if (!directory.hosts.contains(host)) throw ArgumentError('电脑不属于当前列表');
    return catalog.readThread(directory.session, host, threadId, cursor: cursor);
  }

  Future<ThreadPage> readTaskPage(HostDirectory directory, RelayHost host, String threadId, {String? cursor}) async =>
      ThreadPage.fromResponse(await readTask(directory, host, threadId, cursor: cursor), threadId, requestedCursor: cursor);

  Future<Map<String, dynamic>> readTaskSupport(HostDirectory directory, RelayHost host, String threadId, String method) {
    if (!directory.hosts.contains(host)) throw ArgumentError('电脑不属于当前列表');
    return catalog.readTaskSupport(directory.session, host, threadId, method);
  }

  Future<void> watchTask(HostDirectory directory, RelayHost host, String threadId, {bool watching = true, required String leaseId}) async {
    if (!directory.hosts.contains(host) || !sessions.isCurrent(directory.session)) return;
    await catalog.read(directory.session, host, watching ? 'thread/watch' : 'thread/unwatch', {'threadId': threadId, 'leaseId': leaseId});
  }

  Future<List<Map<String, dynamic>>> listArtifacts(HostDirectory directory, RelayHost host, String threadId, {String? cursor}) {
    if (!directory.hosts.contains(host)) throw ArgumentError('电脑不属于当前列表');
    return catalog.listArtifacts(directory.session, host, threadId, cursor: cursor);
  }

  Future<void> downloadArtifact(HostDirectory directory, RelayHost host, String threadId, Map<String, dynamic> artifact,
      RandomAccessFile output, {bool Function()? cancelled, void Function(int bytes, int total)? onProgress}) {
    if (!directory.hosts.contains(host)) throw ArgumentError('电脑不属于当前列表');
    return catalog.downloadArtifact(directory.session, host, threadId, artifact, output,
      cancelled: cancelled, onProgress: onProgress);
  }

  Future<Map<String, dynamic>> options(HostDirectory directory, RelayHost host, {String? threadId}) async {
    if (!directory.hosts.contains(host)) throw ArgumentError('电脑不属于当前列表');
    final ref = directory.session;
    final capabilities = await catalog.capabilities(ref, host);
    final result = <String, dynamic>{'capabilities': capabilities};
    if (threadId != null) {
      if (capabilities.contains('model-control-v1')) {
        try { result['models'] = await catalog.read(ref, host, 'thread/model-options', {'threadId': threadId}); }
        on SignInRequired { rethrow; } on SessionChanged { rethrow; }
        catch (_) { result['models'] = {'data': [], 'controlScope': 'none', 'reason': '暂时无法读取此任务的模型设置，请刷新后重试'}; }
      }
    } else {
      result['projects'] = await catalog.read(ref, host, 'project/list');
      result['agents'] = capabilities.contains('agents-v1') ? await catalog.read(ref, host, 'agent/list')
        : {'data': [{'id': 'codex', 'name': 'Codex', 'available': true,
          'models': (await catalog.read(ref, host, 'model/list') as Map)['data']}]};
    }
    try { result['runtime'] = await catalog.read(ref, host, 'host/runtime'); }
    on SignInRequired { rethrow; } on SessionChanged { rethrow; }
    catch (_) { result['runtime'] = const <String, dynamic>{}; }
    return result;
  }

  String _scope(HostDirectory directory, RelayHost host) => OperationRunner.scope(directory.session.credentials, host.id);
  Future<List<Map<String, dynamic>>> pendingOperations(HostDirectory directory, RelayHost host) => operations.pending(_scope(directory, host));
  Future<dynamic> recoverOperation(HostDirectory directory, RelayHost host, Map<String, dynamic> record) async {
    final key = 'upload:${_scope(directory, host)}:${record['threadId'] ?? 'new'}';
    dynamic result;
    try { result = await operations.recover(_scope(directory, host), record, (method, params) => catalog.read(directory.session, host, method, params), retainSuccess: true); }
    on OperationFailed {
      final raw = await AndroidOperationJournal.channel.invokeMethod<String>('read', {'key': key});
      if (raw != null && raw != '{}') {
        final draft = jsonDecode(raw);
        if (draft is Map && draft['operationId'] == record['operationId']) {
          for (final file in draft['files'] as List? ?? []) { (file as Map)['id'] = null; }
          draft['operationId'] = newOperationId();
          await AndroidOperationJournal.channel.invokeMethod<void>('write', {'key': key, 'json': jsonEncode(draft)});
        }
      }
      rethrow;
    }
    final raw = await AndroidOperationJournal.channel.invokeMethod<String>('read', {'key': key});
    if (raw != null && raw != '{}') {
      final draft = jsonDecode(raw);
      if (draft is Map && draft['operationId'] == record['operationId']) {
        await AndroidOperationJournal.channel.invokeMethod<void>('write', {'key': key, 'json': '{}'});
        for (final item in draft['files'] as List? ?? []) {
          try { await NativeFiles.remove(PickedAttachment.fromJson(Map<String, dynamic>.from(item as Map))); } catch (_) {}
        }
      }
    }
    if (!sessions.isCurrent(directory.session)) throw OperationUncertain(record);
    await operations.confirm(_scope(directory, host), record['operationId'] as String);
    return result;
  }

  Future<List<PickedAttachment>> restoreAttachments(HostDirectory directory, RelayHost host, {String? threadId}) async {
    final key = 'upload:${_scope(directory, host)}:${threadId ?? 'new'}';
    final raw = await AndroidOperationJournal.channel.invokeMethod<String>('read', {'key': key});
    if (raw == null || raw == '{}') return [];
    final draft = jsonDecode(raw);
    if (draft is! Map || draft['files'] is! List) throw const FormatException('待传附件记录无法读取');
    if (!sessions.isCurrent(directory.session)) throw SessionChanged();
    return (draft['files'] as List).map((file) => PickedAttachment.fromJson(Map<String, dynamic>.from(file as Map))).toList();
  }
  Future<void> discardAttachment(HostDirectory directory, RelayHost host, PickedAttachment file, {String? threadId}) async {
    if (!sessions.isCurrent(directory.session)) throw SessionChanged();
    if (file.id != null) {
      try { await catalog.execute(directory.session, host, 'attachment/abort', {'id': file.id, 'token': file.token}); }
      on RpcException catch (error) { if (error.code != 'NOT_FOUND') rethrow; }
    }
    if (!sessions.isCurrent(directory.session)) throw SessionChanged();
    final key = 'upload:${_scope(directory, host)}:${threadId ?? 'new'}';
    final raw = await AndroidOperationJournal.channel.invokeMethod<String>('read', {'key': key});
    if (raw != null && raw != '{}') {
      final draft = jsonDecode(raw);
      if (draft is! Map || draft['files'] is! List) throw const FormatException('待传附件记录无法读取');
      draft['files'] = (draft['files'] as List).where((item) => (item as Map)['slot'] != file.slot).toList();
      await AndroidOperationJournal.channel.invokeMethod<void>('write', {'key': key, 'json': jsonEncode((draft['files'] as List).isEmpty ? {} : draft)});
    }
  }

  Future<dynamic> perform(HostDirectory directory, RelayHost host, String method, Map<String, dynamic> params,
      {List<PickedAttachment> attachments = const [], bool Function()? cancelled, void Function(int, int)? onProgress}) async {
    final scope = _scope(directory, host);
    if (!_activeOperations.add(scope)) throw StateError('这台电脑仍有操作正在处理，请稍后继续');
    try { return await _perform(directory, host, method, params, attachments: attachments, cancelled: cancelled, onProgress: onProgress); }
    finally { _activeOperations.remove(scope); }
  }
  Future<dynamic> _perform(HostDirectory directory, RelayHost host, String method, Map<String, dynamic> params,
      {List<PickedAttachment> attachments = const [], bool Function()? cancelled, void Function(int, int)? onProgress}) async {
    if (!directory.hosts.contains(host) || !sessions.isCurrent(directory.session)) throw SessionChanged();
    final ref = directory.session;
    if (method == 'desktop/launch') return catalog.execute(ref, host, method, params);
    final scope = _scope(directory, host);
    final pending = await operations.pending(scope);
    if (pending.any((item) => item['threadId'] == params['threadId'])) throw OperationUncertain(pending.firstWhere((item) => item['threadId'] == params['threadId']));
    final operationId = newOperationId();
    final request = {...params};
    if (attachments.isNotEmpty) {
      if (!{'thread/start', 'turn/start', 'turn/steer'}.contains(method)) throw ArgumentError('此操作不支持附件');
      final draftKey = 'upload:$scope:${params['threadId'] ?? 'new'}';
      final target = {if (params['threadId'] != null) 'threadId': params['threadId'] else 'cwd': params['cwd'], if (params['agentId'] != null) 'agentId': params['agentId']};
      final before = await AndroidOperationJournal.channel.invokeMethod<String>('read', {'key': draftKey});
      String uploadOperation = operationId;
      if (before != null) {
        final old = jsonDecode(before);
        if (old is Map && old['operationId'] is String && old['files'] is List && jsonEncode(old['target']) == jsonEncode(target) &&
            jsonEncode((old['files'] as List).map((item) => (item as Map)['slot']).toList()) == jsonEncode(attachments.map((file) => file.slot).toList())) {
          uploadOperation = old['operationId'] as String;
          final previous = (old['files'] as List).cast<Map>();
          for (var i = 0; i < attachments.length; i++) { attachments[i].id = previous[i]['id'] as String?; }
        } else { for (final file in attachments) { file.id = null; } }
      }
      Future<void> persist() => AndroidOperationJournal.channel.invokeMethod<void>('write', {'key': draftKey,
        'json': jsonEncode({'operationId': uploadOperation, 'target': target, 'files': attachments.map((file) => file.toJson()).toList()})});
      await persist();
      final result = await catalog.transfer(ref, host, (channel) async {
        if (channel.capabilities.contains('attachments-v2')) {
          final uploader = AttachmentUploader(read: channel.read, write: channel.execute, persist: persist);
          request['attachmentIds'] = await uploader.upload(uploadOperation, target,
            attachments, cancelled: () => !sessions.isCurrent(ref) || cancelled?.call() == true, progress: onProgress);
        } else {
          if (!channel.capabilities.contains('attachments-v1') || attachments.length > 3 ||
              attachments.fold(0, (int sum, file) => sum + file.size) > 800 * 1024 ||
              attachments.any((file) => file.size > (file.mimeType.startsWith('image/') ? 450 : 512) * 1024)) {
            throw StateError('此电脑仅支持旧版小附件，请更新电脑端以支持单个 20 MiB；文件不会被截断或压缩');
          }
          final images = <Map<String, dynamic>>[], files = <Map<String, dynamic>>[];
          for (final file in attachments) {
            final bytes = await File(file.path).readAsBytes();
            if (bytes.length != file.size || sha256.convert(bytes).toString() != file.sha256) throw StateError('文件已变化');
            (file.mimeType.startsWith('image/') ? images : files).add({'filename': file.filename, 'mimeType': file.mimeType, 'data': base64.encode(bytes)});
          }
          if (images.isNotEmpty) request['images'] = images;
          if (files.isNotEmpty) request['files'] = files;
        }
        if (cancelled?.call() == true || !sessions.isCurrent(ref)) throw UploadCancelled();
        try {
          return await operations.run(scope, method, request, (method, params) async {
            final result = await channel.execute(method, params);
            if (!sessions.isCurrent(ref)) throw SessionChanged();
            return result;
          }, (method, params) => catalog.read(ref, host, method, params), operationId: uploadOperation,
            retainSuccess: true, definitelyNotSent: (error) => error is RpcRequestNotSent);
        } on OperationFailed {
          for (final file in attachments) { file.id = null; }
          await AndroidOperationJournal.channel.invokeMethod<void>('write', {'key': draftKey, 'json': '{}'}); rethrow;
        } on RpcRequestNotSent {
          for (final file in attachments) { file.id = null; }
          await AndroidOperationJournal.channel.invokeMethod<void>('write', {'key': draftKey, 'json': '{}'}); rethrow;
        }
      });
      final record = {'operationId': uploadOperation, 'method': method, 'threadId': ?params['threadId']};
      if (!sessions.isCurrent(ref)) throw OperationUncertain(record);
      try { await AndroidOperationJournal.channel.invokeMethod<void>('write', {'key': draftKey, 'json': '{}'}); }
      catch (_) { throw OperationUncertain(record); }
      await operations.confirm(scope, uploadOperation);
      return result;
    }
    final result = await operations.run(scope, method, request, (method, params) => catalog.execute(ref, host, method, params),
      (method, params) => catalog.read(ref, host, method, params), operationId: operationId,
      retainSuccess: true, definitelyNotSent: (error) => error is RpcRequestNotSent);
    if (!sessions.isCurrent(ref)) throw OperationUncertain({'operationId': operationId, 'method': method, 'threadId': ?params['threadId']});
    await operations.confirm(scope, operationId);
    return result;
  }
}
