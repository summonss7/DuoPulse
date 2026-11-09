//! DuoPulse — общие JNI-примитивы мобильной ветки (эталон novagrid-063):
//! подключение потока к JVM и reflection-вызовы по объектам Android.
//! Выделено из mobile_updater.rs в duopulse-085 (второй потребитель —
//! mobile_open.rs): тонкие места (detach с pending exception, классы app'а
//! через classLoader) живут в одном месте. Только Android: десктоп-бин
//! (main.rs) от либы не зависит, iOS-ветки в проекте нет.

#![cfg(target_os = "android")]

use jni::objects::{JClass, JObject, JString};
use jni::JNIEnv;

/// Подключить поток к JVM и отдать env + контекст приложения в замыкание.
/// VM берём из ndk-context (его кладёт tao при старте, контекст — Application,
/// global ref: не дропаем). Перед detach гасим висящую Java-исключение:
/// отсоединение потока с pending exception роняет процесс (FATAL в logcat,
/// поймано в novagrid-063).
pub fn with_jni<T>(
    f: impl FnOnce(&mut JNIEnv, &JObject) -> Result<T, String>,
) -> Result<T, String> {
    let actx = ndk_context::android_context();
    let vm = unsafe { jni::JavaVM::from_raw(actx.vm().cast()).map_err(|e| format!("vm: {e}"))? };
    let mut env = vm
        .attach_current_thread()
        .map_err(|e| format!("attach: {e}"))?;
    let context = unsafe { JObject::from_raw(actx.context().cast()) };
    let out = f(&mut env, &context);
    let _ = env.exception_clear();
    out
}

/// java.lang.String из строки Rust (для сигнатур вызовов).
pub fn jstr<'a>(env: &mut JNIEnv<'a>, s: &str) -> Result<JString<'a>, String> {
    env.new_string(s).map_err(|e| e.to_string())
}

/// Вызов метода без аргументов, возвращающего объект.
pub fn call_obj<'a>(
    env: &mut JNIEnv<'a>,
    obj: &JObject,
    name: &str,
    sig: &str,
) -> Result<JObject<'a>, String> {
    env.call_method(obj, name, sig, &[])
        .map_err(|e| format!("{name}: {e}"))?
        .l()
        .map_err(|e| format!("{name}: {e}"))
}

/// Строковое поле объекта (getPackageName, getAbsolutePath…).
pub fn call_string(env: &mut JNIEnv, obj: &JObject, name: &str, sig: &str) -> Result<String, String> {
    let s = call_obj(env, obj, name, sig)?;
    let js = JString::from(s);
    env.get_string(&js)
        .map(|s| s.to_string_lossy().into_owned())
        .map_err(|e| format!("{name}: {e}"))
}

/// Класс из dex приложения — через classLoader контекста: FindClass с
/// нативно подключённого потока видит только системные классы (как
/// find_class в tauri-runtime).
pub fn app_class<'a>(env: &mut JNIEnv<'a>, context: &JObject, name: &str) -> Result<JClass<'a>, String> {
    let loader = call_obj(env, context, "getClassLoader", "()Ljava/lang/ClassLoader;")?;
    let jname = jstr(env, name)?;
    let class = env
        .call_method(
            &loader,
            "loadClass",
            "(Ljava/lang/String;)Ljava/lang/Class;",
            &[(&jname).into()],
        )
        .map_err(|e| format!("loadClass {name}: {e}"))?
        .l()
        .map_err(|e| format!("loadClass: {e}"))?;
    Ok(JClass::from(class))
}
