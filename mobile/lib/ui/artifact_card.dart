import 'dart:async';
import 'dart:io';
import 'package:flutter/material.dart';
import 'native_file_save.dart';
import 'package:flutter/services.dart';

typedef ArtifactDownload = Future<void> Function(Map<String, dynamic> artifact, RandomAccessFile output,
    {bool Function()? cancelled, void Function(int, int)? onProgress});

/// Downloads into a private, uniquely created cache directory. Only this
/// widget's own fixed-name temporary file is removed on exit or failure.
class ArtifactCard extends StatefulWidget {
  const ArtifactCard({super.key, required this.artifact, required this.download, this.radius = 8, this.autoPreview = false});
  final bool autoPreview;
  final Map<String, dynamic> artifact;
  final ArtifactDownload download;
  final double radius;
  @override State<ArtifactCard> createState() => _ArtifactCardState();
}

class _ArtifactCardState extends State<ArtifactCard> {
  Directory? _directory;
  File? _file;
  String? _text;
  String? _error;
  bool _busy = false;
  bool _saving = false;
  bool _cancelled = false;
  double _progress = 0;

  bool get _image => const {'image/png', 'image/jpeg', 'image/webp', 'image/gif'}.contains(widget.artifact['mimeType']);
  bool get _readable => widget.artifact['mimeType'] == 'text/plain' && (widget.artifact['size'] as int? ?? 0) <= 512 * 1024;
  @override void initState() {
    super.initState();
    if (widget.autoPreview && _image && widget.artifact['unavailable'] == null && (widget.artifact['size'] as int? ?? 0) <= 4 * 1024 * 1024) {
      WidgetsBinding.instance.addPostFrameCallback((_) { if (mounted) unawaited(_load()); });
    }
  }

  @override void dispose() {
    _cancelled = true;
    if (!_busy && !_saving && _directory != null && _file != null) unawaited(_cleanup(_file!, _directory!));
    super.dispose();
  }

  Future<void> _cleanup(File file, Directory directory) async {
    try { if (await file.exists()) await file.delete(); } catch (_) { /* The OS can clear its cache later. */ }
    try { await directory.delete(); } catch (_) { /* Never recursively delete an unexpected directory. */ }
  }

  Future<void> _load() async {
    if (_busy || _file != null || widget.artifact['unavailable'] != null) return;
    setState(() { _busy = true; _cancelled = false; _error = null; _progress = 0; });
    Directory? directory;
    File? file;
    RandomAccessFile? output;
    var keep = false;
    try {
      directory = await Directory.systemTemp.createTemp('pocket-artifact-');
      file = File('${directory.path}${Platform.pathSeparator}content.tmp');
      output = await file.open(mode: FileMode.write);
      await widget.download(widget.artifact, output, cancelled: () => _cancelled || !mounted,
        onProgress: (done, total) { if (mounted && !_cancelled) setState(() => _progress = total == 0 ? 1 : done / total); });
      await output.close(); output = null;
      if (_cancelled || !mounted) return;
      String? text;
      if (_readable) {
        try { text = await file.readAsString(); }
        on FormatException { text = '此文本编码暂不支持预览，请保存后使用其他应用打开。'; }
      }
      if (_cancelled || !mounted) return;
      _directory = directory; _file = file; _text = text; keep = true;
    } catch (_) {
      if (mounted && !_cancelled) _error = '文件读取失败，请刷新对话后重试';
    } finally {
      try { await output?.close(); } catch (_) { /* Preserve the original failure. */ }
      if (keep && (!mounted || _cancelled)) { keep = false; _directory = null; _file = null; _text = null; }
      if (!keep && directory != null && file != null) await _cleanup(file, directory);
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _save() async {
    final file = _file;
    final directory = _directory;
    if (_saving || file == null || directory == null) return;
    setState(() { _saving = true; _error = null; });
    try {
      final name = widget.artifact['name'] is String ? widget.artifact['name'] as String : '文件';
      final mime = widget.artifact['mimeType'] is String ? widget.artifact['mimeType'] as String : 'application/octet-stream';
      final saved = await NativeFileSave.save(file.path, name, mime);
      if (mounted && saved) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('文件已保存')));
    } catch (_) {
      if (mounted) setState(() => _error = '保存未完成，请检查目标文件后重试');
    } finally {
      if (mounted) { setState(() => _saving = false); }
      else { await _cleanup(file, directory); }
    }
  }

  Future<void> _fileAction(String action) async {
    final file = _file;
    if (_saving || file == null) return;
    setState(() => _saving = true);
    try {
      await const MethodChannel('agent_pocket/file_actions').invokeMethod<void>(action, {'path': file.path,
        'name': widget.artifact['name'], 'mimeType': widget.artifact['mimeType']});
    } catch (_) { if (mounted) setState(() => _error = '文件无法打开或分享，请先保存后使用其他应用'); }
    finally { if (mounted) { setState(() => _saving = false); } else if (_directory != null) { await _cleanup(file, _directory!); } }
  }

  void _preview() {
    final file = _file;
    if (file == null) return;
    showDialog<void>(context: context, builder: (context) => Dialog(child: SafeArea(child: Column(
      mainAxisSize: MainAxisSize.min, children: [
        Align(alignment: Alignment.centerRight, child: IconButton(onPressed: () => Navigator.pop(context),
          icon: const Icon(Icons.close), tooltip: '关闭预览')),
        Flexible(child: _image
          ? InteractiveViewer(child: Image(image: ResizeImage(FileImage(file), width: 1600, height: 1600, policy: ResizeImagePolicy.fit),
              errorBuilder: (_, _, _) => const Text('图片无法显示')))
          : SingleChildScrollView(padding: const EdgeInsets.all(16), child: SelectableText(_text ?? ''))),
      ],
    ))));
  }

  @override Widget build(BuildContext context) {
    final name = widget.artifact['name'] is String ? widget.artifact['name'] as String : '文件';
    final unavailable = widget.artifact['unavailable'];
    return Container(margin: const EdgeInsets.only(top: 12), padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(border: Border.all(color: const Color(0xffdedfda)), borderRadius: BorderRadius.circular(widget.radius)),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [Icon(_image ? Icons.image_outlined : Icons.insert_drive_file_outlined, size: 20), const SizedBox(width: 8),
          Expanded(child: Text(name, maxLines: 2, overflow: TextOverflow.ellipsis))]),
        if (unavailable is String) Padding(padding: const EdgeInsets.only(top: 8), child: Text(unavailable))
        else if (_busy) Row(children: [Expanded(child: LinearProgressIndicator(value: _progress)),
          TextButton(onPressed: () => setState(() => _cancelled = true), child: const Text('取消'))])
        else if (_file == null) TextButton(onPressed: () => unawaited(_load()),
          child: Text(_image ? '显示图片' : _readable ? '读取文本' : '读取文件'))
        else ...[
          Wrap(children: [
            if (_image || _readable) TextButton(onPressed: _preview, child: const Text('放大查看')),
            TextButton(onPressed: _saving ? null : () => unawaited(_save()), child: Text(_saving ? '正在保存…' : '保存')),
            TextButton(onPressed: _saving ? null : () => unawaited(_fileAction('share')), child: const Text('分享')),
            TextButton(onPressed: _saving ? null : () => unawaited(_fileAction('open')), child: const Text('用其他应用打开')),
          ]),
          if (_image) InkWell(onTap: _preview, child: Image(image: ResizeImage(FileImage(_file!), width: 1000, height: 1000, policy: ResizeImagePolicy.fit),
            errorBuilder: (_, _, _) => const Text('图片无法显示')))
          else if (_readable) Text(_text ?? '', maxLines: 8, overflow: TextOverflow.ellipsis),
        ],
        if (_error != null) Text(_error!, style: const TextStyle(color: Colors.redAccent)),
      ]));
  }
}
