package crimeradar.util;

import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Base64;

import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.PBEKeySpec;

/**
 * Password hashing for CrimeRadar.
 *
 * New hashes look like pbkdf2$iterations$saltBase64$hashBase64 (PBKDF2WithHmacSHA256,
 * 16-byte random salt, 256-bit key). Old hashes are 64 hex characters of unsalted SHA-256
 * (the seed users); they still verify and are upgraded at login.
 */
public final class Passwords {

	public static final int ITERATIONS = 150000;
	private static final int MIN_ITERATIONS = 120000;
	private static final int MAX_ITERATIONS = 2000000;
	private static final int SALT_BYTES = 16;
	private static final int KEY_BITS = 256;
	private static final SecureRandom RANDOM = new SecureRandom();

	private Passwords() {
	}

	public static String hash(String password) {
		byte[] salt = new byte[SALT_BYTES];
		RANDOM.nextBytes(salt);
		byte[] key = pbkdf2(password, salt, ITERATIONS, KEY_BITS);
		return "pbkdf2$" + ITERATIONS + "$" + Base64.getEncoder().encodeToString(salt) + "$"
			+ Base64.getEncoder().encodeToString(key);
	}

	/** True when the stored hash matches. Compares in constant time. */
	public static boolean verify(String password, String stored) {
		if (stored == null) {
			return false;
		}
		try {
			if (stored.startsWith("pbkdf2$")) {
				String[] parts = stored.split("\\$");
				if (parts.length != 4) {
					return false;
				}
				int iterations = Integer.parseInt(parts[1]);
				if (iterations < 1000 || iterations > MAX_ITERATIONS) {
					return false;
				}
				byte[] salt = Base64.getDecoder().decode(parts[2]);
				byte[] expected = Base64.getDecoder().decode(parts[3]);
				byte[] actual = pbkdf2(password, salt, iterations, expected.length * 8);
				return MessageDigest.isEqual(expected, actual);
			}
			if (isLegacy(stored)) {
				byte[] digest = MessageDigest.getInstance("SHA-256")
					.digest(password.getBytes(StandardCharsets.UTF_8));
				byte[] expected = stored.toLowerCase().getBytes(StandardCharsets.US_ASCII);
				byte[] actual = hex(digest).getBytes(StandardCharsets.US_ASCII);
				return MessageDigest.isEqual(expected, actual);
			}
		} catch (GeneralSecurityException | IllegalArgumentException e) {
			return false;
		}
		return false;
	}

	/** True for a legacy SHA-256 hash or a PBKDF2 hash with too few iterations. */
	public static boolean needsUpgrade(String stored) {
		if (stored == null || isLegacy(stored)) {
			return true;
		}
		if (stored.startsWith("pbkdf2$")) {
			String[] parts = stored.split("\\$");
			try {
				return parts.length != 4 || Integer.parseInt(parts[1]) < MIN_ITERATIONS;
			} catch (NumberFormatException e) {
				return true;
			}
		}
		return true;
	}

	/** Burns about the same time as a real check, so unknown emails are not detectable. */
	public static void dummyVerify(String password) {
		pbkdf2(password, new byte[SALT_BYTES], ITERATIONS, KEY_BITS);
	}

	private static boolean isLegacy(String s) {
		if (s.length() != 64) {
			return false;
		}
		for (int i = 0; i < 64; i++) {
			if (Character.digit(s.charAt(i), 16) < 0) {
				return false;
			}
		}
		return true;
	}

	private static byte[] pbkdf2(String password, byte[] salt, int iterations, int bits) {
		PBEKeySpec spec = new PBEKeySpec(password.toCharArray(), salt, iterations, bits);
		try {
			return SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec)
				.getEncoded();
		} catch (GeneralSecurityException e) {
			throw new IllegalStateException(e);
		} finally {
			spec.clearPassword();
		}
	}

	private static String hex(byte[] bytes) {
		StringBuilder sb = new StringBuilder(bytes.length * 2);
		for (byte b : bytes) {
			sb.append(String.format("%02x", b));
		}
		return sb.toString();
	}
}
