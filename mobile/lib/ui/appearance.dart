import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

enum PocketSkin {
  paper('plain', '纸间', 'assets/scene-paper-v1.png', Color(0xff556578), 16),
  pixel('pixel', '像素', 'assets/scene-pixel-v1.png', Color(0xff476663), 7),
  studio('oil', '画室', 'assets/scene-oil-v1.png', Color(0xff627077), 10);
  const PocketSkin(this.id, this.label, this.scene, this.accent, this.radius);
  final String id;
  final String label;
  final String scene;
  final Color accent;
  final double radius;
  static PocketSkin parse(String? id) => PocketSkin.values.where((skin) => skin.id == id).firstOrNull ?? PocketSkin.paper;

  ThemeData theme() {
    final scheme = ColorScheme.light(primary: accent, onPrimary: Colors.white, secondary: accent, onSecondary: Colors.white,
      surface: Colors.white, onSurface: const Color(0xff262b29), surfaceContainerLow: const Color(0xfff5f5f1),
      surfaceContainer: const Color(0xfff1f2ed), surfaceContainerHigh: const Color(0xffebede8), surfaceContainerHighest: const Color(0xffebede9),
      outline: const Color(0xffc9cdc7), outlineVariant: const Color(0xffe0e2dc), error: const Color(0xffa13d37));
    final bodyFont = this == PocketSkin.pixel ? 'monospace' : this == PocketSkin.studio ? 'serif' : null;
    final base = ThemeData(colorScheme: scheme, useMaterial3: true, fontFamily: bodyFont);
    final headingFont = this == PocketSkin.studio ? 'serif' : this == PocketSkin.pixel ? 'monospace' : null;
    final text = base.textTheme.copyWith(titleLarge: base.textTheme.titleLarge?.copyWith(fontFamily: headingFont),
      titleMedium: base.textTheme.titleMedium?.copyWith(fontFamily: headingFont));
    final shape = RoundedRectangleBorder(borderRadius: BorderRadius.circular(radius));
    final button = ButtonStyle(shape: WidgetStatePropertyAll(shape), minimumSize: const WidgetStatePropertyAll(Size(48, 48)));
    return base.copyWith(textTheme: text, scaffoldBackgroundColor: const Color(0xfffaf9f6),
      cardTheme: CardThemeData(color: Colors.white, elevation: 0, shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(radius))),
      filledButtonTheme: FilledButtonThemeData(style: button), outlinedButtonTheme: OutlinedButtonThemeData(style: button),
      textButtonTheme: TextButtonThemeData(style: button), iconButtonTheme: IconButtonThemeData(style: button),
      chipTheme: base.chipTheme.copyWith(shape: shape, side: BorderSide(color: scheme.outlineVariant),
        selectedColor: scheme.primary.withValues(alpha: .12), backgroundColor: Colors.white),
      dialogTheme: DialogThemeData(shape: shape, backgroundColor: const Color(0xfffaf9f6), surfaceTintColor: Colors.transparent),
      popupMenuTheme: PopupMenuThemeData(shape: shape, color: Colors.white, surfaceTintColor: Colors.transparent),
      bottomSheetTheme: BottomSheetThemeData(shape: RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(radius))),
        backgroundColor: const Color(0xfffaf9f6), surfaceTintColor: Colors.transparent),
      dividerTheme: DividerThemeData(color: scheme.outlineVariant, thickness: 1),
      checkboxTheme: CheckboxThemeData(shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(this == PocketSkin.pixel ? 0 : 3))),
      inputDecorationTheme: InputDecorationTheme(border: OutlineInputBorder(borderRadius: BorderRadius.circular(radius)), isDense: true));
  }
}

class AppearanceController extends ChangeNotifier {
  static const _channel = MethodChannel('agent_pocket/appearance');
  PocketSkin _skin = PocketSkin.paper;
  PocketSkin get skin => _skin;
  Future<void> _tail = Future.value();
  int _revision = 0;
  bool _disposed = false;

  Future<void> load() async {
    final revision = _revision;
    try {
      final value = await _channel.invokeMethod<String>('read');
      if (!_disposed && revision == _revision) { _skin = PocketSkin.parse(value); notifyListeners(); }
    } catch (_) { /* Preserve unreadable legacy settings for later recovery. */ }
  }

  Future<void> select(PocketSkin value) async {
    final revision = ++_revision;
    final previous = _tail;
    final done = Completer<void>();
    _tail = done.future;
    await previous;
    try {
      await _channel.invokeMethod<void>('write', {'skin': value.id});
      if (!_disposed && revision == _revision) { _skin = value; notifyListeners(); }
    } finally { done.complete(); }
  }

  @override void dispose() { _disposed = true; super.dispose(); }
}
