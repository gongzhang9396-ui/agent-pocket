import 'dart:async';
import 'package:flutter/material.dart';
import '../tasks/workspace_controller.dart';
import '../tasks/agent_identity.dart';
import '../tasks/thread_activity.dart';
import 'message_markdown.dart';
import 'artifact_card.dart';
import 'appearance.dart';
import 'composer.dart';
import 'new_task_screen.dart';
import 'interaction_card.dart';
import 'settings_screen.dart';

/// This widget owns its controller; credentials and write receipts live in
/// the app-level service and survive leaving the conversation.
class WorkspaceScreen extends StatefulWidget {
  const WorkspaceScreen({super.key, required this.controller, this.onLoginRequired, this.skin = PocketSkin.paper, this.onSkinChange});
  final WorkspaceController controller;
  final VoidCallback? onLoginRequired;
  final PocketSkin skin;
  final Future<void> Function(PocketSkin)? onSkinChange;
  @override State<WorkspaceScreen> createState() => _WorkspaceScreenState();
}

class _WorkspaceScreenState extends State<WorkspaceScreen> with WidgetsBindingObserver {
  String _query = '';
  String _agent = 'all';
  final _collapsed = <String>{};
  final scroll = ScrollController();
  bool _follow = true;
  String? _lastTask;
  int _lastTimelineLength = 0;
  @override void didUpdateWidget(WorkspaceScreen oldWidget) { super.didUpdateWidget(oldWidget); }
  @override void initState() { super.initState(); WidgetsBinding.instance.addObserver(this); unawaited(widget.controller.refresh()); }
  @override void didChangeAppLifecycleState(AppLifecycleState state) => widget.controller.setVisible(state == AppLifecycleState.resumed);
  @override void dispose() { WidgetsBinding.instance.removeObserver(this); scroll.dispose(); widget.controller.dispose(); super.dispose(); }

  @override Widget build(BuildContext context) => AnimatedBuilder(
    animation: widget.controller,
    builder: (context, _) {
      final state = widget.controller;
      final inTask = state.selectedTaskId != null;
      final progress = state.progress;
      final timelineSize = state.timeline.fold(0, (int size, item) => size + (item.text?.length ?? 1));
      final taskKey = '${state.selectedHost?.id}:${state.selectedTaskId}';
      if (taskKey != _lastTask) { _lastTask = taskKey; _follow = true; _lastTimelineLength = 0; }
      if (inTask && _follow && timelineSize != _lastTimelineLength && !state.loadingEarlier) {
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (mounted && _follow && scroll.hasClients) scroll.jumpTo(scroll.position.maxScrollExtent);
        });
      }
      _lastTimelineLength = timelineSize;
      return PopScope(
        canPop: !inTask,
        onPopInvokedWithResult: (didPop, _) { if (!didPop && inTask) state.closeTask(); },
        child: Scaffold(
          backgroundColor: Theme.of(context).scaffoldBackgroundColor,
          appBar: AppBar(
            titleSpacing: 8,
            backgroundColor: Theme.of(context).scaffoldBackgroundColor,
            leading: inTask ? IconButton(onPressed: state.closeTask, icon: const Icon(Icons.arrow_back), tooltip: '返回任务列表') : null,
            title: Text(inTask ? '对话' : 'Agent Pocket', maxLines: 1, overflow: TextOverflow.ellipsis,
              style: const TextStyle(fontWeight: FontWeight.w600)),
            actions: [if (widget.onSkinChange != null) IconButton(onPressed: _chooseSkin,
              icon: const Icon(Icons.palette_outlined), tooltip: '外观'),
              if (state.service != null) IconButton(onPressed: state.actionBusy ? null : () => Navigator.push(context,
                MaterialPageRoute<void>(builder: (_) => SettingsScreen(service: state.service!, onLoginRequired: widget.onLoginRequired ?? () {}))),
                icon: const Icon(Icons.settings_outlined), tooltip: '设置'),
              if (state.writesEnabled && inTask) PopupMenuButton<String>(tooltip: '任务操作', enabled: !state.actionBusy && !state.selectedPending,
                onSelected: (value) => unawaited(_taskAction(value)), itemBuilder: (_) => [
                  if (state.can('interrupt') && state.activeTurnId != null) const PopupMenuItem(value: 'interrupt', child: Text('停止当前回复')),
                  if (state.can('goal') && state.capabilities.contains('goal-v1')) const PopupMenuItem(value: 'goal', child: Text('持续目标 Goal')),
                  if (state.can('handoff') && state.capabilities.contains('handoff-v1')) const PopupMenuItem(value: 'handoff', child: Text('交接给 Codex Desktop')),
                ]),
              IconButton(onPressed: state.loading || state.loadingTask ? null
                : inTask ? () => unawaited(state.openTask(state.selectedTaskId!)) : () => unawaited(state.refresh()),
              icon: const Icon(Icons.refresh), tooltip: '刷新')],
          ),
          body: LayoutBuilder(builder: (context, constraints) => Stack(children: [
            Positioned(left: 0, right: 0, bottom: 0, height: inTask ? 270 : 170,
              child: IgnorePointer(child: ShaderMask(blendMode: BlendMode.dstIn,
                shaderCallback: (bounds) => const LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter,
                  colors: [Colors.transparent, Colors.white], stops: [0, 0.45]).createShader(bounds),
                child: Image.asset(widget.skin.scene, fit: BoxFit.cover, alignment: Alignment.bottomCenter)))),
            Column(children: [
              if (state.error != null) MaterialBanner(content: Text(state.error!), actions: [
                TextButton(onPressed: state.sessionExpired ? widget.onLoginRequired
                  : inTask ? () => unawaited(state.openTask(state.selectedTaskId!)) : () => unawaited(state.refresh()),
                  child: Text(state.sessionExpired ? '重新登录' : '重试'))]),
              if (inTask && state.artifactError != null) Padding(padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
                child: Text(state.artifactError!, style: const TextStyle(color: Color(0xff5c6865)))),
              if (state.loading || state.loadingTask) const LinearProgressIndicator(minHeight: 2),
              if (state.pending.isNotEmpty) Padding(padding: const EdgeInsets.symmetric(horizontal: 16), child: Row(children: [
                const Expanded(child: Text('有操作结果待确认')), TextButton(onPressed: state.actionBusy ? null : () => unawaited(state.recoverPending()), child: const Text('查询回执'))])),
              Expanded(child: inTask ? _conversation(state) : _catalog(state)),
              if (inTask && progress != null) Padding(padding: const EdgeInsets.fromLTRB(20, 4, 20, 8),
                child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  const Padding(padding: EdgeInsets.only(top: 3), child: Icon(Icons.more_horiz, size: 18)),
                  const SizedBox(width: 8), Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text(state.writesEnabled && !state.connected ? '连接恢复中 · 最近进展' : progress.title,
                      style: Theme.of(context).textTheme.labelLarge),
                    Text(progress.text.trim().isEmpty ? '等待电脑传回下一步进展' : progress.text,
                      maxLines: 2, overflow: TextOverflow.ellipsis, style: Theme.of(context).textTheme.bodySmall),
                  ])),
                ])),
              if (inTask && state.writesEnabled) ConstrainedBox(constraints: BoxConstraints(maxHeight: (constraints.maxHeight * .55).clamp(0, 380)), child: ChatComposer(key: ValueKey('${state.selectedHost?.id}:${state.selectedTaskId}'),
                canSend: state.can('send') && !state.runningWithoutSteer && !state.selectedPending, canPlan: state.can('plan') && state.capabilities.contains('plan-v1'),
                disabledReason: state.selectedPending ? '请先查询原操作回执' : state.runningWithoutSteer ? '正在执行，请等待本轮结束或停止回复' : null,
                canAttach: state.canAttach && (state.capabilities.contains('attachments-v2') || state.capabilities.contains('attachments-v1')),
                busy: state.actionBusy, active: state.activeTurnId != null && state.canSteer, models: state.options['models'] as Map? ?? const {}, progress: state.uploadProgress, onCancelUpload: state.cancelUpload,
                restoreFiles: state.restoreAttachments,
                discardFile: state.discardAttachment,
                clearRevision: state.draftRevision,
                onSend: (text, model, effort, plan, files) async {
                  final active = state.canSteer ? state.activeTurnId : null;
                  await state.perform(active == null ? 'turn/start' : 'turn/steer', {
                    'threadId': state.selectedTaskId, 'text': text, 'expectedTurnId': ?active,
                    if (active == null && model != null) 'model': model, if (active == null && effort != null) 'effort': effort,
                    if (active == null && plan) 'mode': 'plan'}, attachments: files);
                }))
              else if (inTask) const SafeArea(top: false, child: Padding(padding: EdgeInsets.fromLTRB(20, 8, 20, 12),
                child: ColoredBox(color: Color(0xfffaf9f6), child: Padding(padding: EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                  child: Text('当前开发版仅支持查看', style: TextStyle(color: Color(0xff465653))))))),
            ]),
          ])),
        ),
      );
    },
  );

  Future<void> _taskAction(String action) async {
    final state = widget.controller, id = widget.controller.selectedTaskId;
    if (id == null) return;
    try {
      if (action == 'interrupt' && state.activeTurnId != null) {
        await state.perform('turn/interrupt', {'threadId': id, 'turnId': state.activeTurnId});
      } else if (action == 'handoff') {
        final accepted = await showDialog<bool>(context: context, builder: (ctx) => AlertDialog(title: const Text('交接到电脑'),
          content: const Text('当前 Host 执行器会在确认空闲后释放任务，后续通过 Codex Desktop 继续。'),
          actions: [TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('返回')),
            FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('交接'))]));
        if (accepted == true) await state.perform('thread/handoff', {'threadId': id});
      } else if (action == 'goal') {
        final text = TextEditingController();
        try {
          final current = await state.readGoal();
          if (!mounted) return;
          final goal = current['goal'];
          text.text = (goal is Map ? goal['objective'] : current['objective']) as String? ?? '';
          final choice = await showDialog<String>(context: context, builder: (ctx) => AlertDialog(title: const Text('持续目标 Goal'),
            content: TextField(controller: text, maxLines: 5, decoration: const InputDecoration(hintText: '输入持续任务目标')),
            actions: [TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('返回')),
              TextButton(onPressed: () => Navigator.pop(ctx, 'clear'), child: const Text('清除目标')),
              FilledButton(onPressed: () => Navigator.pop(ctx, 'set'), child: const Text('保存'))]));
          if (choice == 'clear') await state.perform('goal/clear', {'threadId': id});
          if (choice == 'set' && text.text.trim().isNotEmpty) await state.perform('goal/set', {'threadId': id, 'objective': text.text.trim()});
        } finally { text.dispose(); }
      }
    } catch (_) { /* Controller shows the operation outcome. */ }
  }

  void _chooseSkin() {
    showModalBottomSheet<void>(context: context, builder: (sheetContext) => SafeArea(child: SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(20, 16, 20, 24), child: Column(mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('外观', style: Theme.of(sheetContext).textTheme.titleLarge),
          const SizedBox(height: 12),
          for (final skin in PocketSkin.values) ListTile(
            leading: ClipRRect(borderRadius: BorderRadius.circular(skin.radius / 2),
              child: Image.asset(skin.scene, width: 62, height: 42, fit: BoxFit.cover, alignment: Alignment.bottomCenter)),
            title: Text(skin.label), trailing: skin == widget.skin ? const Icon(Icons.check) : null,
            onTap: () async {
              try {
                await widget.onSkinChange!(skin);
                if (sheetContext.mounted) Navigator.pop(sheetContext);
              } catch (_) {
                if (sheetContext.mounted) ScaffoldMessenger.of(sheetContext).showSnackBar(const SnackBar(content: Text('外观保存失败，请重试')));
              }
            },
          ),
        ]))));
  }

  Widget _catalog(WorkspaceController state) {
    final agentIds = {'all', 'codex', 'grok', 'dsh', ...state.tasks.map(threadAgentId)};
    final rows = state.tasks.where((item) {
      final text = '${item['name'] ?? ''} ${item['preview'] ?? ''} ${item['cwd'] ?? ''}';
      return (_agent == 'all' || threadAgentId(item) == _agent) && text.toLowerCase().contains(_query.toLowerCase());
    }).toList();
    final groups = <String, List<Map<String, dynamic>>>{};
    for (final row in rows) { groups.putIfAbsent(row['cwd'] as String? ?? '', () => []).add(row); }
    final display = <Map<String, dynamic>>[];
    for (final entry in groups.entries) {
      final key = '${state.selectedHost?.id}:$_agent:${entry.key}';
      display.add({'_group': true, 'cwd': entry.key, 'key': key, 'count': entry.value.length});
      if (!_collapsed.contains(key)) display.addAll(entry.value);
    }
    return Column(children: [
      if (state.writesEnabled) Padding(padding: const EdgeInsets.symmetric(horizontal: 16), child: Row(children: [
        Expanded(child: FilledButton.icon(onPressed: state.selectedHost?.online == true && !state.actionBusy && !state.creationPending
          ? () => Navigator.push(context, MaterialPageRoute<void>(builder: (_) => NewTaskScreen(controller: state))) : null,
          icon: const Icon(Icons.add), label: const Text('新建任务'))),
        const SizedBox(width: 8), IconButton(onPressed: state.selectedHost?.online == true && !state.actionBusy ? () => unawaited(_wakeDesktop()) : null,
          icon: const Icon(Icons.desktop_windows_outlined), tooltip: '唤起 Codex Desktop'),
      ])),
      Padding(padding: const EdgeInsets.fromLTRB(16, 8, 16, 12), child: Row(children: [
        const Icon(Icons.computer_outlined, size: 20), const SizedBox(width: 10),
        Expanded(child: DropdownButtonHideUnderline(child: DropdownButton(
          isExpanded: true, value: state.selectedHost,
          hint: const Text('选择电脑'),
          items: state.hosts.map((host) => DropdownMenuItem(value: host,
            child: Text('${host.name} · ${host.online ? '在线' : '离线'}', overflow: TextOverflow.ellipsis))).toList(),
          onChanged: (host) { if (host != null) unawaited(state.selectHost(host)); },
        ))),
      ])),
      Padding(padding: const EdgeInsets.symmetric(horizontal: 16), child: TextField(
        onChanged: (value) => setState(() => _query = value),
        decoration: const InputDecoration(prefixIcon: Icon(Icons.search), hintText: '搜索任务',
          isDense: true),
      )),
      SingleChildScrollView(scrollDirection: Axis.horizontal, padding: const EdgeInsets.fromLTRB(16, 8, 16, 0), child: Row(children: [
        for (final agent in agentIds) Padding(padding: const EdgeInsets.only(right: 8), child: ChoiceChip(
          label: Text('${agentLabel(agent)} ${state.tasks.where((row) => agent == 'all' || threadAgentId(row) == agent).length}'),
          selected: _agent == agent, onSelected: (_) => setState(() => _agent = agent))),
      ])),
      if (state.writesEnabled) Padding(padding: const EdgeInsets.fromLTRB(16, 6, 16, 0), child: Align(alignment: Alignment.centerLeft,
        child: Text(state.connected ? '已连接' : '连接暂不可用，正在恢复', style: Theme.of(context).textTheme.bodySmall))),
      Expanded(child: rows.isEmpty && !state.loading
        ? const Center(child: Text('没有可显示的任务'))
        : ListView.builder(padding: const EdgeInsets.fromLTRB(16, 12, 16, 130), itemCount: display.length,
          itemBuilder: (context, index) {
            final row = display[index];
            if (row['_group'] == true) {
              final cwd = row['cwd'] as String, key = row['key'] as String;
              final label = cwd.split(RegExp(r'[\\/]')).where((part) => part.isNotEmpty).lastOrNull ?? '其他任务';
              return ListTile(contentPadding: const EdgeInsets.symmetric(horizontal: 6), leading: const Icon(Icons.folder_outlined),
                title: Text(label, maxLines: 1, overflow: TextOverflow.ellipsis), subtitle: Text('${row['count']} 个任务'),
                trailing: Icon(_collapsed.contains(key) ? Icons.expand_more : Icons.expand_less),
                onTap: () => setState(() { if (!_collapsed.remove(key)) _collapsed.add(key); }));
            }
            final id = row['id'] as String;
            final title = (row['name'] is String && (row['name'] as String).isNotEmpty)
              ? row['name'] as String : (row['preview'] is String && (row['preview'] as String).isNotEmpty)
                ? row['preview'] as String : '未命名任务';
            final cwd = row['cwd'] is String ? row['cwd'] as String : '';
            return Card(child: ListTile(
              title: Text(title, maxLines: 2, overflow: TextOverflow.ellipsis),
              subtitle: cwd.isEmpty ? null : Text(cwd, maxLines: 1, overflow: TextOverflow.ellipsis),
              trailing: state.unreadTasks.contains(id) ? const Icon(Icons.circle, size: 9) : const Icon(Icons.chevron_right), onTap: () => unawaited(state.openTask(id)),
            ));
          })),
    ]);
  }

  Widget _conversation(WorkspaceController state) {
    final detail = state.detail;
    if (detail == null) return Center(child: Text(state.loadingTask ? '正在读取对话…' : '暂无可显示的对话'));
    final messages = state.timeline.where((item) => (item.text != null && item.text!.isNotEmpty) ||
      itemActivity(item.raw) != null || item.type == 'pocketApproval' || item.type == 'pocketQuestion').toList();
    if (messages.isEmpty && !state.hasEarlier) return const Center(child: Text('暂无可显示的对话'));
    return NotificationListener<UserScrollNotification>(onNotification: (notice) {
      if (scroll.hasClients) _follow = scroll.position.extentAfter < 90;
      return false;
    }, child: ListView.builder(controller: scroll, padding: const EdgeInsets.fromLTRB(18, 16, 18, 26), itemCount: messages.length + (state.hasEarlier ? 1 : 0),
      itemBuilder: (context, index) {
        if (state.hasEarlier && index == 0) { return Center(child: TextButton(
          onPressed: state.loadingEarlier ? null : () => unawaited(() async {
            _follow = false;
            final before = scroll.hasClients ? scroll.position.maxScrollExtent : 0.0, offset = scroll.hasClients ? scroll.offset : 0.0;
            await state.loadEarlier();
            WidgetsBinding.instance.addPostFrameCallback((_) { if (mounted && scroll.hasClients) scroll.jumpTo((offset + scroll.position.maxScrollExtent - before).clamp(0, scroll.position.maxScrollExtent)); });
          }()),
          child: Text(state.loadingEarlier ? '正在读取…' : '读取更早的消息'))); }
        final item = messages[index - (state.hasEarlier ? 1 : 0)];
        if (state.writesEnabled && (item.type == 'pocketApproval' || item.type == 'pocketQuestion')) {
          final group = messages.where((value) => value.type == item.type && (value.raw['requestId'] ?? value.id) == (item.raw['requestId'] ?? item.id)).toList();
          if (group.first.id != item.id) return const SizedBox.shrink();
          return InteractionCard(key: ValueKey(item.id), items: group, enabled: !state.actionBusy && !state.selectedPending && state.can(item.type == 'pocketApproval' ? 'approval' : 'question'),
            onAction: (method, params) async { await state.perform(method, {...params, 'threadId': state.selectedTaskId}); });
        }
        if (item.type == 'pocketApproval' || item.type == 'pocketQuestion') {
          final approval = item.type == 'pocketApproval';
          final raw = approval ? item.raw['summary'] : item.raw['prompt'];
          final title = raw is String && raw.isNotEmpty ? raw : approval ? '需要审批' : '需要回答';
          final resolved = approval ? item.raw['decision'] != null : item.raw['selectedOption'] != null;
          final unavailable = item.raw['unavailableReason'];
          return Card(child: Padding(padding: const EdgeInsets.all(14), child: Column(
            crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(approval ? '审批' : '问题', style: Theme.of(context).textTheme.titleSmall),
              const SizedBox(height: 8), SelectableText(title), const SizedBox(height: 8),
              Text(resolved ? '已处理' : unavailable is String && unavailable.isNotEmpty ? unavailable
                : item.raw['available'] == false ? '此交互已结束' : '请在电脑端处理',
                style: Theme.of(context).textTheme.bodySmall),
            ])));
        }
        final user = item.type == 'userMessage';
        final activity = itemActivity(item.raw);
        if (activity != null) {
          return Card(child: ExpansionTile(key: PageStorageKey('${state.selectedTaskId}:${item.id}'),
            title: Text([activity.title, activityStatus(activity.status)].where((part) => part.isNotEmpty).join(' · ')),
            subtitle: activity.text.isEmpty ? null : Text(activity.text.replaceAll(RegExp(r'\s+'), ' '), maxLines: 2, overflow: TextOverflow.ellipsis),
            children: [Padding(padding: const EdgeInsets.all(12), child: activity.text.isEmpty
              ? Text(item.type == 'reasoning' ? '模型未提供公开思考摘要' : '等待更多执行信息')
              : MessageMarkdown(key: PageStorageKey('activity-body:${state.selectedTaskId}:${item.id}'),
                text: const {'commandExecution', 'fileChange', 'diff'}.contains(item.type)
                ? '```\n${activity.text}\n```' : activity.text, radius: widget.skin.radius))]));
        }
        final artifacts = state.artifacts.where((artifact) => artifact['messageId'] == item.artifactMessageId).toList();
        return Align(alignment: user ? Alignment.centerRight : Alignment.centerLeft,
          child: Container(margin: const EdgeInsets.only(bottom: 20), padding: const EdgeInsets.all(14),
            constraints: const BoxConstraints(maxWidth: 680),
            decoration: BoxDecoration(color: user ? Theme.of(context).colorScheme.surfaceContainerHighest : Colors.white,
              borderRadius: BorderRadius.circular(widget.skin.radius)), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                MessageMarkdown(text: item.type == 'diff' ? '```diff\n${item.text}\n```' : item.text!, radius: widget.skin.radius),
                for (final artifact in artifacts) ArtifactCard(
                  key: ValueKey('${state.selectedHost?.id}:${state.selectedTaskId}:${artifact['id']}:${artifact['messageId']}'),
                  artifact: artifact, download: state.downloadArtifact, radius: widget.skin.radius, autoPreview: true),
              ])));
      }));
  }

  Future<void> _wakeDesktop() async {
    final state = widget.controller;
    try {
      final options = await state.loadOptions(forNew: true);
      if (!mounted) return;
      final caps = options['capabilities'] as Set<String>? ?? const {};
      final desktop = (options['runtime'] as Map?)?['desktop'];
      if (!caps.contains('desktop-wake-safe-v2') || desktop is! Map || desktop['safeLaunch'] != true || desktop['canWake'] != true) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Codex 已打开、正在启动，或此电脑尚不支持安全唤起'))); return;
      }
      await state.perform('desktop/launch', {});
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('已请求电脑启动 Codex')));
    } catch (_) { if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('暂时无法确认启动结果，请刷新电脑状态'))); }
  }
}
