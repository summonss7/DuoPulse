package dev.duopulse.mobile

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/*
 * Хранилище секретов мобильной ветки (duopulse-112, этап 6 duopulse-106):
 * та же роль, что DPAPI на десктопе (src-tauri/src/secrets.rs) — на диске
 * лежит только шифроблоб, ключ из устройства не вынимается. Ключ
 * AES-256-GCM живёт в системном AndroidKeyStore (создаётся при первом
 * обращении), формат блоба: "v1:" + base64( len(iv,1Б) || iv || ct+tag ).
 * Вызывается из Rust по имени через JNI (secrets.rs → mobile_jni), исключения
 * гасятся здесь и возвращаются строкой "error: …" (как MobileOpenHelper).
 */
object MobileKeystoreHelper {
  private const val ALIAS = "duopulse_secrets"
  private const val HEADER = "v1:"

  private fun key(): SecretKey {
    val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    (ks.getKey(ALIAS, null) as? SecretKey)?.let { return it }
    val kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
    kg.init(
      KeyGenParameterSpec.Builder(
          ALIAS,
          KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256)
        .build())
    return kg.generateKey()
  }

  @JvmStatic
  fun seal(context: Context, plain: String): String {
    return try {
      val cipher = Cipher.getInstance("AES/GCM/NoPadding")
      cipher.init(Cipher.ENCRYPT_MODE, key())
      val ct = cipher.doFinal(plain.toByteArray(Charsets.UTF_8))
      val iv = cipher.iv
      HEADER + Base64.encodeToString(byteArrayOf(iv.size.toByte()) + iv + ct, Base64.NO_WRAP)
    } catch (e: Exception) {
      "error: ${e.message}"
    }
  }

  @JvmStatic
  fun unseal(context: Context, blob: String): String {
    return try {
      val b = Base64.decode(blob.removePrefix(HEADER), Base64.NO_WRAP)
      val ivLen = b[0].toInt() and 0xff
      if (ivLen <= 0 || ivLen >= b.size) throw IllegalArgumentException("битый блоб секрета")
      val cipher = Cipher.getInstance("AES/GCM/NoPadding")
      cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, b.copyOfRange(1, 1 + ivLen)))
      String(cipher.doFinal(b.copyOfRange(1 + ivLen, b.size)), Charsets.UTF_8)
    } catch (e: Exception) {
      "error: ${e.message}"
    }
  }
}
