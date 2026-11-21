import 'package:integration_test/integration_test.dart';
import '../test/dsh_questions_test.dart' as questions;
import '../test/widget_test.dart' as workspace;
import 'write_ui_test.dart' as controls;
import 'dsh_state_test.dart' as state;
import 'workspace_controller_test.dart' as controller;

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  questions.main();
  workspace.main();
  controls.main();
  state.main();
  controller.main();
}
