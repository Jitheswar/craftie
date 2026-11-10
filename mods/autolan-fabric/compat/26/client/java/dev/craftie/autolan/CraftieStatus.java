package dev.craftie.autolan;

import java.io.Reader;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

/**
 * What every Craftie on this PC is doing right now. Craftie writes a small status file each
 * second (~/.craftie/status.json, status-Craftie1.json, ...); this reads them in the background.
 * Nothing goes over the network, so nobody else needs the mod.
 */
public final class CraftieStatus {
	public record Entry(String name, float health, int food, double x, double y, double z, String dim, String job, boolean following) {}

	private static final Path DIR = Path.of(System.getProperty("user.home"), ".craftie");
	private static final long STALE_MS = 6000; // Craftie stopped writing: it left or isn't running
	private static volatile List<Entry> entries = List.of();

	private CraftieStatus() {}

	public static List<Entry> entries() { return entries; }

	public static void start() {
		Thread t = new Thread(() -> {
			while (true) {
				try { entries = read(); } catch (Exception e) { entries = List.of(); }
				try { Thread.sleep(1000); } catch (InterruptedException e) { return; }
			}
		}, "craftie-status");
		t.setDaemon(true);
		t.start();
	}

	private static List<Entry> read() throws Exception {
		List<Entry> out = new ArrayList<>();
		if (!Files.isDirectory(DIR)) return out;
		long now = System.currentTimeMillis();
		try (DirectoryStream<Path> files = Files.newDirectoryStream(DIR, "status*.json")) {
			for (Path f : files) {
				try (Reader r = Files.newBufferedReader(f)) {
					JsonObject o = JsonParser.parseReader(r).getAsJsonObject();
					if (now - Instant.parse(o.get("at").getAsString()).toEpochMilli() > STALE_MS) continue;
					JsonObject p = o.getAsJsonObject("pos");
					out.add(new Entry(str(o, "name", "Craftie"), o.get("health").getAsFloat(), o.get("food").getAsInt(),
						p.get("x").getAsDouble(), p.get("y").getAsDouble(), p.get("z").getAsDouble(),
						str(o, "dim", ""), str(o, "job", null), !o.get("following").isJsonNull()));
				} catch (Exception ignored) {} // half-written or old-format file: skip it this second
			}
		}
		// Craftie first, then Craftie1, Craftie2, ...
		out.sort(Comparator.comparingInt((Entry e) -> e.name().length()).thenComparing(Entry::name));
		return out;
	}

	private static String str(JsonObject o, String key, String fallback) {
		return o.has(key) && !o.get(key).isJsonNull() ? o.get(key).getAsString() : fallback;
	}
}
