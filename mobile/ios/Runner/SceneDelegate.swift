import Flutter
import UIKit

class SceneDelegate: FlutterSceneDelegate {
  override func scene(_ scene: UIScene, willConnectTo session: UISceneSession,
                      options connectionOptions: UIScene.ConnectionOptions) {
    guard let windowScene = scene as? UIWindowScene else { return }
    let app = UIApplication.shared.delegate as! AppDelegate
    let sceneWindow = UIWindow(windowScene: windowScene)
    sceneWindow.rootViewController = FlutterViewController(engine: app.flutterEngine, nibName: nil, bundle: nil)
    window = sceneWindow
    super.scene(scene, willConnectTo: session, options: connectionOptions)
    sceneWindow.makeKeyAndVisible()
  }
}
