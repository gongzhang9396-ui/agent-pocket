import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';
import 'package:markdown/markdown.dart' as md;
import 'package:url_launcher/url_launcher.dart';

/// Links require a user tap; images never trigger unsolicited network or local
/// file reads. Host artifact previews are handled by a separate trusted flow.
class MessageMarkdown extends StatelessWidget {
  const MessageMarkdown({super.key, required this.text, this.radius = 8});
  final String text;
  final double radius;
  @override Widget build(BuildContext context) => MarkdownBody(
    data: text,
    selectable: true,
    builders: {'pre': _CodeBuilder(radius)},
    imageBuilder: (_, _, alt) => Text(alt == null || alt.isEmpty ? '[图片]' : '[图片：$alt]',
      style: const TextStyle(color: Color(0xff5c6865))),
    onTapLink: (_, href, _) {
      final uri = href == null ? null : Uri.tryParse(href);
      if (uri == null || !{'http', 'https'}.contains(uri.scheme.toLowerCase()) || uri.host.isEmpty || uri.userInfo.isNotEmpty) return;
      unawaited(_open(context, uri));
    },
  );

  Future<void> _open(BuildContext context, Uri uri) async {
    try {
      if (await launchUrl(uri, mode: LaunchMode.externalApplication)) return;
    } catch (_) { /* The system did not open the link. */ }
    if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('无法打开链接')));
  }
}

class _CodeBuilder extends MarkdownElementBuilder {
  _CodeBuilder(this.radius);
  final double radius;
  @override bool isBlockElement() => true;
  @override Widget visitElementAfterWithContext(BuildContext context, md.Element element, TextStyle? preferredStyle, TextStyle? parentStyle) {
    final code = element.textContent;
    return Container(margin: const EdgeInsets.symmetric(vertical: 6),
      decoration: BoxDecoration(color: Theme.of(context).colorScheme.surfaceContainerLow, borderRadius: BorderRadius.circular(radius)),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Align(alignment: Alignment.centerRight, child: IconButton(tooltip: '复制代码', icon: const Icon(Icons.copy, size: 17),
          onPressed: () async {
            await Clipboard.setData(ClipboardData(text: code));
            if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('代码已复制')));
          })),
        SingleChildScrollView(scrollDirection: Axis.horizontal, padding: const EdgeInsets.fromLTRB(12, 0, 12, 12),
          child: SelectableText(code, style: const TextStyle(fontFamily: 'monospace', fontSize: 13))),
      ]));
  }
}
