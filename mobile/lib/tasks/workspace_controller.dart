import 'package:flutter/foundation.dart';
import 'dart:async';
import 'dart:io';
import '../protocol/relay_hosts.dart';
import '../session/pocket_session_service.dart';
import '../session/session_manager.dart';
import 'thread_page.dart';
import 'thread_activity.dart';
import 'attachment_uploader.dart';
import 'operation_runner.dart';
import '../protocol/relay_event_feed.dart';
import '../protocol/rpc_client.dart';
import 'native_files.dart';
import 'agent_identity.dart';

typedef DirectoryReader = Future<HostDirectory> Function();
typedef CatalogReader = Future<List<Map<String, dynamic>>> Function(HostDirectory directory, RelayHost host);
typedef TaskReader = Future<Map<String, dynamic>> Function(HostDirectory directory, RelayHost host, String id);
typedef EarlierTaskReader = Future<Map<String, dynamic>> Function(HostDirectory directory, RelayHost host, String id, String cursor);
typedef ArtifactListReader = Future<List<Map<String, dynamic>>> Function(HostDirectory directory, RelayHost host, String id, {String? cursor});
typedef ArtifactFileReader = Future<void> Function(HostDirectory directory, RelayHost host, String id,
  Map<String, dynamic> artifact, RandomAccessFile file, {bool Function()? cancelled, void Function(int, int)? onProgress});

/// Page-independent read state. Old network results cannot change a newer
/// selection and leaving a page does not cancel the app-level session.
class WorkspaceController extends ChangeNotifier {
  WorkspaceController({required this.readDirectory, required this.readCatalog, required this.readTask, required this.isCurrent,
    this.readArtifacts, this.readArtifactFile, this.readEarlier, this.service}) {
    _feedSubscription = service?.feed.updates.listen(_onFeed);
  }
  StreamSubscription<FeedUpdate>? _feedSubscription;
  Timer? _feedRefresh;
  Timer? _watchTimer;
  Timer? _progressTimer;
  HostDirectory? _watchedDirectory;
  RelayHost? _watchedHost;
  String? _watchedTask;
  String? _watchedLease;
  bool _visible = true;
  void setVisible(bool value) {
    _visible = value;
    if (value) { _startWatch(); _startProgressPoll(); _scheduleFeedRefresh(); }
    else { _releaseWatch(); _progressTimer?.cancel(); _progressTimer = null; }
  }
  void _startProgressPoll() {
    _progressTimer?.cancel();
    if (!_visible || _taskId == null) return;
    _progressTimer = Timer.periodic(const Duration(seconds: 4), (_) {
      if (_visible && progress != null) _scheduleFeedRefresh();
    });
  }
  void _releaseWatch() {
    _watchTimer?.cancel(); _watchTimer = null;
    final directory = _watchedDirectory, host = _watchedHost, id = _watchedTask, lease = _watchedLease;
    _watchedDirectory = null; _watchedHost = null; _watchedTask = null; _watchedLease = null;
    if (directory != null && host != null && id != null && lease != null && service != null) unawaited(service!.watchTask(directory, host, id, watching: false, leaseId: lease).catchError((Object _) {}));
  }
  void _startWatch() {
    final directory = _directory, host = _host, id = _taskId;
    if (_disposed || !_visible || service == null || directory == null || host == null || id == null || !id.startsWith('dsh:')) return;
    if (_watchedTask == id && _watchedHost == host && _watchTimer != null) return;
    _releaseWatch(); _watchedDirectory = directory; _watchedHost = host; _watchedTask = id;
    final lease = '${DateTime.now().microsecondsSinceEpoch}:$_taskGeneration'; _watchedLease = lease;
    var renewing = false;
    Future<void> renew() async {
      if (renewing || _disposed || !_visible || _taskId != id || _watchedLease != lease || !isCurrent(directory)) return;
      renewing = true;
      try { await service!.watchTask(directory, host, id, leaseId: lease); } catch (_) { /* The lease expires if the connection cannot be renewed. */ }
      finally {
        renewing = false;
        if (_disposed || !_visible || _watchedLease != lease) unawaited(service!.watchTask(directory, host, id, watching: false, leaseId: lease).catchError((Object _) {}));
      }
    }
    unawaited(renew()); _watchTimer = Timer.periodic(const Duration(seconds: 15), (_) => unawaited(renew()));
  }
  bool _feedRefreshing = false, _feedRefreshAgain = false;
  bool _connected = false;
  bool get connected => _connected;
  String? _eventActiveTurn;
  final Set<String> _finishedTurns = {};
  final Map<String, ThreadItem> _liveItems = {};
  final Map<String, int> _liveVersions = {};
  final Set<String> _unreadTasks = {};
  Set<String> get unreadTasks => service?.feed.unread(_host?.id ?? '') ?? Set.unmodifiable(_unreadTasks);
  int _liveRevision = 0;

  void _onFeed(FeedUpdate update) {
    if (_disposed) return;
    if (update.sessionGeneration != null && _directory != null && update.sessionGeneration != _directory!.session.generation) return;
    if (update.type == 'connected' || update.type == 'disconnected') { _connected = update.type == 'connected'; _changed(); return; }
    if (update.type == 'directory') { unawaited(refresh()); return; }
    if (update.type == 'loginRequired') { _clearSession(); return; }
    if (update.hostId != _host?.id) return;
    final value = update.value;
    if (update.type == 'event' && value != null) {
      final id = value['threadId'], type = value['type'], payload = value['payload'];
      if (id is String && id != _taskId && !update.replayed) _unreadTasks.add(id);
      if (!update.replayed && id == _taskId && payload is Map) {
        if (type == 'message.delta' && payload['itemId'] is String && payload['delta'] is String) {
          final itemId = payload['itemId'] as String, delta = payload['delta'] as String;
          if (payload['remove'] == true) {
            _liveItems.remove(itemId); _liveVersions[itemId] = ++_liveRevision;
          } else {
          final previous = _liveItems[itemId] ?? timeline.where((item) => item.id == itemId).firstOrNull;
          final text = payload['replace'] == true ? delta : '${previous?.text ?? ''}$delta';
          final user = payload['role'] == 'user';
          final itemType = user ? 'userMessage' : payload['itemType'] == 'plan' || previous?.type == 'plan' ? 'plan' : 'agentMessage';
          final turn = value['turnId'] as String? ?? previous?.turnId ?? 'live';
          _liveItems[itemId] = ThreadItem(id: itemId, turnId: turn, type: itemType, text: text,
            raw: {'id': itemId, 'type': itemType, 'text': text});
          _liveVersions[itemId] = ++_liveRevision;
          }
        } else if (type == 'turn.status') {
          final turn = value['turnId'];
          if (turn is String && runningStatus(payload['status'])) { _eventActiveTurn = turn; }
          if (turn is String && finishedStatus(payload['status'])) {
            _finishedTurns.add(turn); if (_eventActiveTurn == turn) _eventActiveTurn = null;
          }
        } else if (type == 'activity.updated' || type == 'command.updated' || type == 'plan.updated') {
          final turn = value['turnId'] as String? ?? activeTurnId ?? 'live';
          final itemId = payload['item'] is Map ? payload['item']['id'] : payload['itemId'] ?? 'pocket-plan-$turn';
          final previous = _liveItems[itemId] ?? timeline.where((item) => item.id == itemId).firstOrNull;
          final raw = activityEventItem(type as String, payload, previous?.raw, turn);
          if (itemId is String && raw != null) {
            _liveItems[itemId] = ThreadItem(id: itemId, turnId: turn, type: raw['type'] as String, text: itemActivity(raw)?.text, raw: raw);
            _liveVersions[itemId] = ++_liveRevision;
          }
        } else if (type == 'diff.updated' && payload['diff'] is String) {
          const itemId = 'live-diff';
          _liveItems[itemId] = ThreadItem(id: itemId, turnId: value['turnId'] as String? ?? '', type: 'diff',
            text: payload['diff'] as String, raw: {...Map<String, dynamic>.from(payload), 'type': 'diff'}); _liveVersions[itemId] = ++_liveRevision;
        }
        _changed();
      }
      // Token deltas update locally; terminal/interactions need authoritative
      // snapshots. Replay never appends an old delta to a newer history page.
      if ({'message.delta', 'activity.updated', 'command.updated'}.contains(type) && !update.replayed &&
        payload is Map && payload['complete'] != true && !finishedStatus(payload['item'] is Map ? payload['item']['status'] : null)) { return; }
    }
    _scheduleFeedRefresh();
  }
  void _scheduleFeedRefresh() {
    if (_feedRefresh?.isActive == true) return;
    _feedRefresh = Timer(const Duration(milliseconds: 700), () => unawaited(_syncFromFeed()));
  }
  Future<void> _syncFromFeed() async {
    if (_feedRefreshing) { _feedRefreshAgain = true; return; }
    final directory = _directory, host = _host, id = _taskId, generation = _taskGeneration, listGeneration = _listGeneration;
    if (_disposed || directory == null || host == null || !host.online || !isCurrent(directory)) return;
    _feedRefreshing = true; final revision = _liveRevision;
    try {
      if (id != null) {
        final result = await readTask(directory, host, id);
        if (_disposed || generation != _taskGeneration || !isCurrent(directory)) return;
        final page = ThreadPage.fromResponse(result, id);
        if (_latestPage?.revision != null && page.revision != null && _latestPage!.revision != page.revision) {
          _earlierPages = const []; _seenHistoryCursors.clear();
        }
        _latestPage = page; _detail = Map.unmodifiable(result);
        final thread = result['thread'];
        if (thread is Map && threadAgentId(thread) == 'dsh' && thread['liveItemIds'] is List) {
          final liveIds = (thread['liveItemIds'] as List).whereType<String>().toSet();
          for (final key in _liveItems.keys.toList()) {
            if (key.startsWith('dsh-live-') && !liveIds.contains(key) && (_liveVersions[key] ?? 0) <= revision) { _liveItems.remove(key); _liveVersions.remove(key); }
          }
        }
        for (final item in page.items) {
          if ((_liveVersions[item.id] ?? revision + 1) <= revision) { _liveItems.remove(item.id); _liveVersions.remove(item.id); }
        }
        if (readArtifacts != null) unawaited(_loadArtifacts(directory, host, id, generation));
        if (service != null) unawaited(loadOptions().catchError((Object _) => <String, dynamic>{}));
        if (service != null) unawaited(refreshInteractions());
      }
      final rows = await readCatalog(directory, host);
      if (!_disposed && listGeneration == _listGeneration && isCurrent(directory)) { _tasks = List.unmodifiable(rows); _changed(); }
    } catch (_) {
      if (!_disposed && generation == _taskGeneration && listGeneration == _listGeneration && isCurrent(directory)) {
        _error = '部分实时记录尚未补齐，已保留当前对话；恢复连接后可刷新'; _changed();
      }
    }
    finally { _feedRefreshing = false; if (_feedRefreshAgain && !_disposed) { _feedRefreshAgain = false; _scheduleFeedRefresh(); } }
  }
  factory WorkspaceController.fromService(PocketSessionService service) => WorkspaceController(
    readDirectory: service.listHosts, readCatalog: service.listTasks,
    readTask: (directory, host, id) => service.readTask(directory, host, id),
    isCurrent: (directory) => service.sessions.isCurrent(directory.session),
    readArtifacts: service.listArtifacts, readArtifactFile: service.downloadArtifact,
    readEarlier: (directory, host, id, cursor) => service.readTask(directory, host, id, cursor: cursor), service: service);
  final PocketSessionService? service;
  bool get writesEnabled => service != null;
  Map<String, dynamic> _options = const {};
  Map<String, dynamic> get options => _options;
  Set<String> get capabilities => (_options['capabilities'] as Set<String>?) ?? const {};
  bool _actionBusy = false;
  bool get actionBusy => _actionBusy;
  bool _cancelUpload = false;
  double? _uploadProgress;
  double? get uploadProgress => _uploadProgress;
  List<Map<String, dynamic>> _pending = const [];
  List<Map<String, dynamic>> get pending => _pending;
  bool get selectedPending => _taskId != null && _pending.any((record) => record['threadId'] == _taskId);
  bool get creationPending => _pending.any((record) => record['threadId'] == null && record['method'] == 'thread/start');
  int _draftRevision = 0;
  int get draftRevision => _draftRevision;
  bool can(String action) {
    final thread = _detail?['thread'];
    if (service == null || thread is! Map) return false;
    final execution = thread['execution'];
    final caps = execution is Map ? execution['capabilities'] : thread['capabilities'];
    return caps is Map && caps[action] == true;
  }
  bool get canSteer {
    final thread = _detail?['thread'];
    return thread is Map && can('send') && taskSupports(thread, 'steer');
  }
  bool get runningWithoutSteer => activeTurnId != null && !canSteer;
  bool get canAttach => _detail?['thread'] is Map && taskSupports(_detail!['thread'] as Map, 'attachments');
  ThreadActivity? get progress {
    final thread = _detail?['thread'];
    if (thread is! Map) { return null; }
    final waiting = timeline.where((item) => const {'pocketApproval', 'pocketQuestion'}.contains(item.type) &&
      item.raw['available'] == true && item.raw['decision'] == null && item.raw['selectedOption'] == null).firstOrNull;
    if (waiting != null) {
      return ThreadActivity(waiting.type == 'pocketApproval' ? '等待你批准' : '等待你回答',
        waiting.type == 'pocketApproval' ? '在对话中确认后继续' : '回答对话中的问题后继续', 'waiting');
    }
    final turnId = activeTurnId;
    if (turnId == null && (!runningStatus(thread['status']) || _finishedTurns.isNotEmpty)) return null;
    final latest = timeline.reversed.where((item) => item.turnId == turnId &&
      (item.type == 'agentMessage' || itemActivity(item.raw) != null)).firstOrNull;
    if (latest?.type == 'agentMessage') return ThreadActivity('正在回复', latest!.text ?? '', 'inProgress');
    final activity = latest == null ? null : itemActivity(latest.raw);
    if (activity == null) return const ThreadActivity('正在处理', '等待电脑传回下一步进展', 'inProgress');
    final steps = latest!.raw['plan'];
    final step = steps is List ? steps.whereType<Map>().where((row) => runningStatus(row['status'])).firstOrNull : null;
    return ThreadActivity(activity.status.isNotEmpty && !runningStatus(activity.status) ? '正在处理下一步' : activity.title,
      step?['step'] is String ? step!['step'] as String : activity.text, 'inProgress');
  }
  String? get activeTurnId {
    final thread = _detail?['thread'];
    if (thread is! Map) return null;
    final turns = thread['turns'];
    if (_eventActiveTurn != null) {
      final matching = turns is List ? turns.whereType<Map>().where((turn) => turn['id'] == _eventActiveTurn).firstOrNull : null;
      if (matching == null || !finishedStatus(matching['status'])) return _eventActiveTurn;
    }
    if (thread['activeTurnId'] is String && !_finishedTurns.contains(thread['activeTurnId'])) return thread['activeTurnId'] as String;
    if (turns is List) {
      for (final turn in turns.reversed.whereType<Map>()) {
        final status = turn['status'];
        if (runningStatus(status) && turn['id'] is String && !_finishedTurns.contains(turn['id'])) return turn['id'] as String;
      }
    }
    return null;
  }

  Future<Map<String, dynamic>> loadOptions({bool forNew = false}) async {
    final directory = _directory, host = _host, id = _taskId;
    final generation = forNew ? _listGeneration : _taskGeneration;
    if (service == null || directory == null || host == null) return const {};
    Map<String, dynamic> value;
    try { value = await service!.options(directory, host, threadId: forNew ? null : id); }
    on SignInRequired {
      if (!_disposed && generation == (forNew ? _listGeneration : _taskGeneration)) _clearSession();
      rethrow;
    } on SessionChanged {
      if (!_disposed && generation == (forNew ? _listGeneration : _taskGeneration)) _clearSession();
      rethrow;
    }
    if (_disposed || generation != (forNew ? _listGeneration : _taskGeneration) || !isCurrent(directory)) throw SessionChanged();
    if (!forNew) {
      _options = value;
      final interactions = value['interactions'];
      if (interactions is Map && interactions['items'] is List && _detail != null && _taskId == id) {
        final thread = Map<String, dynamic>.from(_detail!['thread'] as Map);
        thread['interactionItems'] = interactions['items'];
        if (interactions['execution'] is Map) { thread['execution'] = interactions['execution']; }
        _detail = {..._detail!, 'thread': thread}; _latestPage = ThreadPage.fromResponse(_detail!, id!);
      }
      _changed();
    }
    return value;
  }

  Future<void> refreshInteractions() async {
    final directory = _directory, host = _host, id = _taskId, generation = _taskGeneration;
    if (directory == null || host == null || id == null || service == null) return;
    try {
      final result = await service!.readTaskSupport(directory, host, id, 'thread/interactions');
      if (_disposed || generation != _taskGeneration || _detail == null) return;
      if (!isCurrent(directory)) { _clearSession(); return; }
      if (result['items'] is! List) throw const FormatException('交互快照格式无效');
      final thread = Map<String, dynamic>.from(_detail!['thread'] as Map)..['interactionItems'] = result['items'];
      if (result['execution'] is Map) thread['execution'] = result['execution'];
      _detail = {..._detail!, 'thread': thread}; _latestPage = ThreadPage.fromResponse(_detail!, id); _changed();
    } on SignInRequired {
      if (!_disposed && generation == _taskGeneration) _clearSession();
    } on SessionChanged {
      if (!_disposed && generation == _taskGeneration) _clearSession();
    } catch (_) { /* Old Hosts may not provide a separate interaction snapshot. */ }
  }

  void cancelUpload() { _cancelUpload = true; }
  Future<void> discardAttachment(PickedAttachment file, {bool forNew = false}) async {
    final directory = _directory, host = _host;
    if (_actionBusy || directory == null || host == null || service == null) throw StateError('附件暂不可移除');
    await service!.discardAttachment(directory, host, file, threadId: forNew ? null : _taskId); await NativeFiles.remove(file);
  }
  Future<List<PickedAttachment>> restoreAttachments({bool forNew = false}) async {
    final directory = _directory, host = _host, generation = _taskGeneration;
    if (directory == null || host == null || service == null) return [];
    final files = await service!.restoreAttachments(directory, host, threadId: forNew ? null : _taskId);
    if (_disposed || generation != _taskGeneration || !isCurrent(directory)) throw SessionChanged();
    return files;
  }
  Future<Map<String, dynamic>> readGoal() async {
    final directory = _directory, host = _host, id = _taskId, generation = _taskGeneration;
    if (directory == null || host == null || id == null || service == null) throw StateError('任务不可读取');
    final goal = await service!.readTaskSupport(directory, host, id, 'goal/get');
    if (_disposed || generation != _taskGeneration || !isCurrent(directory)) throw SessionChanged();
    return goal;
  }
  Future<dynamic> perform(String method, Map<String, dynamic> params, {List<PickedAttachment> attachments = const []}) async {
    final directory = _directory, host = _host;
    final taskGeneration = _taskGeneration, listGeneration = _listGeneration;
    if (_actionBusy || service == null || directory == null || host == null) throw StateError('操作暂不可用');
    _actionBusy = true; _cancelUpload = false; _error = null; _uploadProgress = attachments.isEmpty ? null : 0; _changed();
    try {
      final result = await service!.perform(directory, host, method, params, attachments: attachments,
        cancelled: () => _cancelUpload,
        onProgress: (bytes, total) { if (!_disposed) { _uploadProgress = bytes / total; _changed(); } });
      if (_disposed || !isCurrent(directory) || listGeneration != _listGeneration) return result;
      if ({'thread/start', 'turn/start', 'turn/steer'}.contains(method)) _draftRevision++;
      final newId = result is Map && result['thread'] is Map ? result['thread']['id'] : null;
      if (newId is String && method == 'thread/start') {
        await refresh();
        if (!_disposed && isCurrent(directory) && _host?.id == host.id) await openTask(newId);
      } else if (_taskId != null && taskGeneration == _taskGeneration) { await openTask(_taskId!); }
      _pending = await service!.pendingOperations(directory, host);
      return result;
    } on OperationUncertain {
      if (!_disposed && listGeneration == _listGeneration && isCurrent(directory)) {
        _pending = await service!.pendingOperations(directory, host);
        _error = '操作结果待确认，请查询回执；不会自动重复发送';
      }
      rethrow;
    } catch (error) {
      if (!_disposed && listGeneration == _listGeneration && isCurrent(directory)) {
        _error = error is UploadCancelled ? '已停止上传，未发送任务；可稍后继续' : '操作未完成：$error';
      }
      rethrow;
    } finally {
      _actionBusy = false; _uploadProgress = null;
      if (!_disposed && identical(_directory, directory) && !isCurrent(directory)) _clearSession();
      _changed();
    }
  }

  Future<void> recoverPending() async {
    final directory = _directory, host = _host;
    if (_actionBusy || directory == null || host == null || service == null) return;
    _actionBusy = true; _changed();
    try {
      final records = await service!.pendingOperations(directory, host);
      String? createdId;
      String? failure;
      for (final record in records) {
        try {
          final result = await service!.recoverOperation(directory, host, record);
          if (record['threadId'] == _taskId && {'turn/start', 'turn/steer'}.contains(record['method'])) _draftRevision++;
          if (record['method'] == 'thread/start' && result is Map && result['thread'] is Map && result['thread']['id'] is String) createdId = result['thread']['id'] as String;
        } on OperationUncertain { /* Continue reconciling other receipts without resubmitting. */ }
        on OperationFailed catch (error) { failure = error.message; }
      }
      if (!_disposed && isCurrent(directory) && _host?.id == host.id) {
        _pending = await service!.pendingOperations(directory, host);
        await refresh(); if (createdId != null) { await openTask(createdId); } else if (_taskId != null) { await openTask(_taskId!); }
        _error = _pending.isNotEmpty ? '仍有操作结果待确认，请稍后查询' : failure;
      }
    } catch (_) { if (!_disposed) _error = '仍未取得确定回执，请稍后查询原操作'; }
    finally { _actionBusy = false; _changed(); }
  }
  final DirectoryReader readDirectory;
  final CatalogReader readCatalog;
  final TaskReader readTask;
  final bool Function(HostDirectory) isCurrent;
  final ArtifactListReader? readArtifacts;
  final ArtifactFileReader? readArtifactFile;
  final EarlierTaskReader? readEarlier;

  HostDirectory? _directory;
  RelayHost? _host;
  List<Map<String, dynamic>> _tasks = const [];
  Map<String, dynamic>? _detail;
  ThreadPage? _latestPage;
  List<ThreadPage> _earlierPages = const [];
  final Set<String> _seenHistoryCursors = {};
  bool _loadingEarlier = false;
  List<Map<String, dynamic>> _artifacts = const [];
  final Map<String, int> _artifactRanks = {};
  String? _artifactError;
  String? _taskId;
  String? _error;
  bool _loading = false;
  bool _loadingTask = false;
  bool _sessionExpired = false;
  bool _disposed = false;
  int _listGeneration = 0;
  int _taskGeneration = 0;

  List<RelayHost> get hosts => _directory?.hosts ?? const [];
  RelayHost? get selectedHost => _host;
  List<Map<String, dynamic>> get tasks => _tasks;
  Map<String, dynamic>? get detail => _detail;
  bool get loadingEarlier => _loadingEarlier;
  bool get hasEarlier => readEarlier != null && (_earlierPages.isEmpty ? _latestPage : _earlierPages.first)?.hasMore == true;
  List<ThreadItem> get timeline {
    final pages = [..._earlierPages];
    if (_latestPage != null) { pages.add(_latestPage!); }
    final all = [for (final page in pages) ...page.items.where((item) =>
      !item.id.startsWith('dsh-live-') || !_liveVersions.containsKey(item.id) || _liveItems.containsKey(item.id)), ..._liveItems.values];
    final newest = <String, ThreadItem>{for (final item in all) item.id: item};
    final seen = <String>{};
    return List.unmodifiable([for (final item in all) if (seen.add(item.id)) newest[item.id]!]);
  }
  List<Map<String, dynamic>> get artifacts => _artifacts;
  String? get artifactError => _artifactError;
  String? get selectedTaskId => _taskId;
  String? get error => _error;
  bool get loading => _loading;
  bool get loadingTask => _loadingTask;
  bool get sessionExpired => _sessionExpired;
  void _changed() { if (!_disposed) notifyListeners(); }
  void _clearSession() {
    _directory = null; _host = null; _tasks = const []; _detail = null; _taskId = null; _artifacts = const []; _artifactRanks.clear(); _artifactError = null;
    _resetHistory();
    _pending = const []; _options = const {}; _unreadTasks.clear();
    _listGeneration++; _taskGeneration++; _loading = false; _loadingTask = false;
    _sessionExpired = true;
    _error = '登录状态已变化，请重新登录后刷新';
    _changed();
  }

  Future<void> refresh() async {
    final generation = ++_listGeneration;
    _loading = true; _error = null; _changed();
    try {
      final directory = await readDirectory();
      if (_disposed || generation != _listGeneration) return;
      if (!isCurrent(directory)) { _clearSession(); return; }
      final previous = _host?.id;
      RelayHost? selected;
      for (final host in directory.hosts) { if (host.id == previous) { selected = host; break; } }
      selected ??= directory.hosts.where((host) => host.online).firstOrNull ?? directory.hosts.firstOrNull;
      final oldSession = _directory?.session;
      final sessionChanged = oldSession != null && (oldSession.generation != directory.session.generation ||
        oldSession.credentials['accountId'] != directory.session.credentials['accountId'] ||
        oldSession.credentials['endpoint'] != directory.session.credentials['endpoint']);
      final hostChanged = sessionChanged || previous != selected?.id;
      _directory = directory; _host = selected;
      if (service != null) unawaited(service!.feed.start(directory.session, directory.hosts).catchError((Object _) {}));
      if (hostChanged) { _tasks = const []; _detail = null; _taskId = null; _artifacts = const []; _artifactRanks.clear(); _artifactError = null; _resetHistory(); _taskGeneration++; _loadingTask = false; }
      _changed();
      if (selected == null) { _tasks = const []; return; }
      if (!selected.online) { _error = _offlineHostMessage(selected); return; }
      final rows = await readCatalog(directory, selected);
      if (_disposed || generation != _listGeneration) return;
      if (!isCurrent(directory)) { _clearSession(); return; }
      _tasks = List.unmodifiable(rows);
      if (service != null) {
        final pending = await service!.pendingOperations(directory, selected);
        if (!_disposed && generation == _listGeneration && isCurrent(directory)) _pending = pending;
      }
    } on SignInRequired {
      if (!_disposed && generation == _listGeneration) _clearSession();
    } on SessionChanged {
      if (!_disposed && generation == _listGeneration) _clearSession();
    } catch (error) {
      if (!_disposed && generation == _listGeneration) {
        _error = error is RpcException && error.code == 'HOST_OFFLINE' && _host != null
          ? _offlineHostMessage(_host!) : '读取电脑或任务失败，请检查连接后重试';
      }
    } finally {
      if (!_disposed && generation == _listGeneration) { _loading = false; _changed(); }
    }
  }

  String _offlineHostMessage(RelayHost host) => '电脑「${host.name}」当前离线，请启动该电脑上的 Agent Pocket Host 后刷新';

  Future<void> selectHost(RelayHost host) async {
    final directory = _directory;
    if (directory == null || !directory.hosts.contains(host)) throw ArgumentError('电脑不属于当前列表');
    final generation = ++_listGeneration;
    _taskGeneration++;
    _host = host; _tasks = const []; _taskId = null; _detail = null; _artifacts = const []; _artifactRanks.clear(); _artifactError = null; _resetHistory();
    _options = const {}; _pending = const [];
    _error = null; _loading = true; _loadingTask = false; _changed();
    try {
      if (!host.online) { _error = _offlineHostMessage(host); return; }
      final rows = await readCatalog(directory, host);
      if (!_disposed && generation == _listGeneration) {
        if (!isCurrent(directory)) { _clearSession(); return; }
        _tasks = List.unmodifiable(rows);
        if (service != null) {
          final pending = await service!.pendingOperations(directory, host);
          if (!_disposed && generation == _listGeneration && isCurrent(directory)) _pending = pending;
        }
      }
    } on SignInRequired {
      if (!_disposed && generation == _listGeneration) _clearSession();
    } on SessionChanged {
      if (!_disposed && generation == _listGeneration) _clearSession();
    } catch (error) {
      if (!_disposed && generation == _listGeneration) {
        _error = error is RpcException && error.code == 'HOST_OFFLINE'
          ? _offlineHostMessage(host) : '读取这台电脑的任务失败，请检查连接后重试';
      }
    } finally {
      if (!_disposed && generation == _listGeneration) { _loading = false; _changed(); }
    }
  }

  Future<void> openTask(String id) async {
    final directory = _directory;
    final host = _host;
    if (directory == null || host == null || id.isEmpty) throw StateError('请先选择电脑和任务');
    final generation = ++_taskGeneration;
    _taskId = id; _detail = null; _artifacts = const []; _artifactRanks.clear(); _artifactError = null; _resetHistory(); _error = null; _loadingTask = true; _changed();
    _options = const {};
    _unreadTasks.remove(id);
    service?.feed.view(_host?.id, id);
    try {
      final detail = await readTask(directory, host, id);
      if (!_disposed && generation == _taskGeneration) {
        if (!isCurrent(directory)) { _clearSession(); return; }
        _latestPage = ThreadPage.fromResponse(detail, id);
        _detail = Map.unmodifiable(detail);
        _startWatch();
        _startProgressPoll();
        if (readArtifacts != null) unawaited(_loadArtifacts(directory, host, id, generation));
        if (service != null) unawaited(loadOptions().catchError((Object _) => <String, dynamic>{}));
        if (service != null) unawaited(refreshInteractions());
      }
    } on SignInRequired {
      if (!_disposed && generation == _taskGeneration) _clearSession();
    } on SessionChanged {
      if (!_disposed && generation == _taskGeneration) _clearSession();
    } catch (_) {
      if (!_disposed && generation == _taskGeneration) _error = '读取任务内容失败，请检查连接后重试';
    } finally {
      if (!_disposed && generation == _taskGeneration) { _loadingTask = false; _changed(); }
    }
  }

  void _resetHistory() {
    _releaseWatch();
    _progressTimer?.cancel(); _progressTimer = null;
    service?.feed.view(null, null);
    _latestPage = null; _earlierPages = const []; _seenHistoryCursors.clear(); _loadingEarlier = false;
    _liveItems.clear(); _liveVersions.clear(); _eventActiveTurn = null; _finishedTurns.clear();
  }

  Future<void> loadEarlier() async {
    final directory = _directory, host = _host, id = _taskId;
    final source = _earlierPages.isEmpty ? _latestPage : _earlierPages.first;
    final cursor = source?.nextCursor;
    if (_loadingEarlier || directory == null || host == null || id == null || cursor == null || readEarlier == null) return;
    final generation = _taskGeneration;
    _loadingEarlier = true; _error = null; _changed();
    try {
      final result = await readEarlier!(directory, host, id, cursor);
      if (_disposed || generation != _taskGeneration) return;
      if (!isCurrent(directory)) { _clearSession(); return; }
      final page = ThreadPage.fromResponse(result, id, requestedCursor: cursor);
      if (page.nextCursor != null && _seenHistoryCursors.contains(page.nextCursor)) throw const FormatException('历史游标重复');
      final currentRevision = _latestPage?.revision ?? _earlierPages.map((value) => value.revision).whereType<String>().firstOrNull;
      if (currentRevision != null && page.revision != null && currentRevision != page.revision) {
        throw const FormatException('历史已变化，请重新刷新任务');
      }
      _seenHistoryCursors.add(cursor);
      _earlierPages = List.unmodifiable([page, ..._earlierPages]);
      if (readArtifacts != null) unawaited(_loadArtifacts(directory, host, id, generation, cursor: cursor, priority: -_earlierPages.length));
    } on SignInRequired {
      if (!_disposed && generation == _taskGeneration) _clearSession();
    } on SessionChanged {
      if (!_disposed && generation == _taskGeneration) _clearSession();
    } catch (_) {
      if (!_disposed && generation == _taskGeneration) _error = '无法读取更早的消息，请刷新任务后重试';
    } finally {
      if (!_disposed && generation == _taskGeneration) { _loadingEarlier = false; _changed(); }
    }
  }

  Future<void> _loadArtifacts(HostDirectory directory, RelayHost host, String id, int generation, {String? cursor, int priority = 0}) async {
    try {
      final result = await readArtifacts!(directory, host, id, cursor: cursor);
      if (_disposed || generation != _taskGeneration) return;
      if (!isCurrent(directory)) { _clearSession(); return; }
      final merged = <String, Map<String, dynamic>>{};
      String keyOf(Map<String, dynamic> artifact) {
        if (artifact['messageId'] is! String || (artifact['messageId'] as String).isEmpty || (artifact['messageId'] as String).contains('\u0000') ||
            artifact['source'] is! String || (artifact['source'] as String).isEmpty || (artifact['source'] as String).contains('\u0000')) {
          throw const FormatException('文件引用无效');
        }
        return '${artifact['messageId']}\u0000${artifact['source']}';
      }
      for (final artifact in _artifacts) { merged[keyOf(artifact)] = artifact; }
      final ranks = {..._artifactRanks};
      for (final artifact in result) {
        final key = keyOf(artifact);
        if (priority >= (ranks[key] ?? -0x7fffffff)) { merged[key] = artifact; ranks[key] = priority; }
      }
      _artifactRanks..clear()..addAll(ranks);
      _artifacts = List.unmodifiable(merged.values);
    } on SignInRequired {
      if (!_disposed && generation == _taskGeneration) _clearSession();
    } on SessionChanged {
      if (!_disposed && generation == _taskGeneration) _clearSession();
    } catch (_) {
      if (!_disposed && generation == _taskGeneration) _artifactError = '暂时无法读取对话文件；请确认电脑端已更新';
    } finally { if (!_disposed && generation == _taskGeneration) _changed(); }
  }

  Future<void> downloadArtifact(Map<String, dynamic> artifact, RandomAccessFile file,
      {bool Function()? cancelled, void Function(int, int)? onProgress}) async {
    final directory = _directory, host = _host, id = _taskId;
    final generation = _taskGeneration;
    if (directory == null || host == null || id == null || readArtifactFile == null || !_artifacts.contains(artifact)) {
      throw StateError('当前文件不可读取');
    }
    bool invalid() => _disposed || generation != _taskGeneration || !isCurrent(directory) || cancelled?.call() == true;
    await readArtifactFile!(directory, host, id, artifact, file, cancelled: invalid, onProgress: onProgress);
    if (invalid()) throw SessionChanged();
  }

  void closeTask() {
    service?.feed.view(null, null);
    _taskGeneration++;
    _taskId = null; _detail = null; _artifacts = const []; _artifactRanks.clear(); _artifactError = null; _resetHistory(); _loadingTask = false; _changed();
  }

  @override void dispose() {
    _releaseWatch();
    _progressTimer?.cancel();
    _disposed = true; _listGeneration++; _taskGeneration++;
    _feedRefresh?.cancel(); unawaited(_feedSubscription?.cancel());
    service?.feed.view(null, null);
    super.dispose();
  }
}
