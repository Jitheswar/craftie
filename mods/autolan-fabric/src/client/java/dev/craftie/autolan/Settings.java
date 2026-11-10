package dev.craftie.autolan;

import java.io.Reader;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Properties;

import net.fabricmc.loader.api.FabricLoader;

/**
 * The mod's settings, from config/craftie-autolan.properties. Read once at startup; any setting
 * the file doesn't have yet is added to it with a one-line explanation.
 */
public final class Settings {
	/** Open every singleplayer world to LAN as soon as you're in it. */
	public static boolean enabled = true;
	/** Show the Craftie status panel (newer Minecraft versions only). */
	public static boolean hud = true;
	/** Your Craftie's Minecraft name: who the order box and /craftie talk to. */
	public static String name = "Craftie";

	private static final Map<String, String[]> DEFAULTS = new LinkedHashMap<>(); // key -> {default, explanation}
	static {
		DEFAULTS.put("enabled", new String[] { "true", "Set to false to stop opening worlds to LAN automatically." });
		DEFAULTS.put("hud", new String[] { "true", "Show the Craftie status panel in the top-left corner. There is also a key for this in Controls." });
		DEFAULTS.put("name", new String[] { "Craftie", "Your Craftie's Minecraft name: who the order box and /craftie talk to." });
		load();
	}

	private Settings() {}

	private static void load() {
		Path file = FabricLoader.getInstance().getConfigDir().resolve("craftie-autolan.properties");
		try {
			Properties p = new Properties();
			String text = Files.exists(file) ? Files.readString(file) : "";
			if (!text.isEmpty()) try (Reader r = Files.newBufferedReader(file)) { p.load(r); }
			StringBuilder missing = new StringBuilder();
			DEFAULTS.forEach((key, d) -> { if (!p.containsKey(key)) missing.append("# ").append(d[1]).append('\n').append(key).append('=').append(d[0]).append('\n'); });
			if (missing.length() > 0) Files.writeString(file, text + (text.isEmpty() || text.endsWith("\n") ? "" : "\n") + missing);
			enabled = !"false".equalsIgnoreCase(p.getProperty("enabled", "true").trim());
			hud = !"false".equalsIgnoreCase(p.getProperty("hud", "true").trim());
			String n = p.getProperty("name", "").trim();
			if (!n.isEmpty()) name = n;
		} catch (Exception e) {
			// Unreadable settings never stop the game: keep the defaults.
		}
	}
}
