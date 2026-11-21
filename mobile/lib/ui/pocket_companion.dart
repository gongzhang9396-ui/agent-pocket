import 'package:flutter/material.dart';

/// The same four-state character sheet used by the accepted Web appearance.
class PocketCompanion extends StatelessWidget {
  const PocketCompanion({super.key, this.frame = 0});
  final int frame;
  @override Widget build(BuildContext context) => ExcludeSemantics(child: SizedBox(width: 42, height: 44, child: ClipRect(
    child: OverflowBox(minWidth: 84, maxWidth: 84, minHeight: 88, maxHeight: 88,
      alignment: [Alignment.topLeft, Alignment.topRight, Alignment.bottomLeft, Alignment.bottomRight][frame.clamp(0, 3)],
      child: Image.asset('assets/pocket-companion.png', width: 84, height: 88, fit: BoxFit.fill, filterQuality: FilterQuality.none)),
  )));
}
