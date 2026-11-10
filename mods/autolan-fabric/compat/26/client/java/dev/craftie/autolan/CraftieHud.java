package dev.craftie.autolan;

import java.util.List;

import net.minecraft.client.DeltaTracker;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.Font;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.client.player.AbstractClientPlayer;

/** A small panel in the top-left corner: each Craftie's health, food, distance, direction and job. */
public final class CraftieHud {
	private static final String[] ARROWS = { "↑", "↗", "→", "↘", "↓", "↙", "←", "↖" };
	private static final int MAX_WIDTH = 190;

	private CraftieHud() {}

	public static void draw(GuiGraphicsExtractor g, DeltaTracker delta) {
		Minecraft mc = Minecraft.getInstance();
		if (!Settings.hud || mc.player == null || mc.level == null) return;
		List<CraftieStatus.Entry> list = CraftieStatus.entries();
		if (list.isEmpty()) return;
		Font font = mc.font;
		int x = 4, y = 4, pad = 3, line = font.lineHeight + 1;

		String[] top = new String[list.size()], job = new String[list.size()];
		int width = 0;
		for (int i = 0; i < list.size(); i++) {
			CraftieStatus.Entry e = list.get(i);
			// Not in this world (e.g. you're in another world or server): don't show it.
			if (mc.getConnection() == null || mc.getConnection().getPlayerInfo(e.name()) == null) continue;
			top[i] = "§a" + e.name() + " §c❤" + Math.round(e.health()) + " §6🍖" + e.food() + " §f" + where(mc, e);
			job[i] = "§7" + fit(font, describe(e), MAX_WIDTH);
			width = Math.max(width, Math.max(font.width(top[i]), font.width(job[i])));
		}
		int rows = 0;
		for (String t : top) if (t != null) rows++;
		if (rows == 0) return;
		g.fill(x - pad, y - pad, x + width + pad, y + rows * 2 * line + pad - 1, 0x90000000);
		for (int i = 0; i < top.length; i++) {
			if (top[i] == null) continue;
			g.text(font, top[i], x, y, 0xFFFFFFFF, true);
			g.text(font, job[i], x, y + line, 0xFFFFFFFF, true);
			y += 2 * line;
		}
	}

	/** "12m ↗": how far, and which way relative to where you're looking. */
	private static String where(Minecraft mc, CraftieStatus.Entry e) {
		double tx = e.x() + 0.5, ty = e.y(), tz = e.z() + 0.5;
		boolean seen = false;
		for (AbstractClientPlayer p : mc.level.players()) {
			if (p.getGameProfile().name().equalsIgnoreCase(e.name())) { tx = p.getX(); ty = p.getY(); tz = p.getZ(); seen = true; break; }
		}
		// Craftie is in another dimension: its coordinates mean nothing here.
		String here = mc.level.dimension().identifier().getPath();
		if (!seen && !e.dim().isEmpty() && !here.equals(e.dim())) return "in the " + e.dim().replace("the_", "").replace('_', ' ');
		double dx = tx - mc.player.getX(), dy = ty - mc.player.getY(), dz = tz - mc.player.getZ();
		int dist = (int) Math.round(Math.sqrt(dx * dx + dy * dy + dz * dz));
		if (dist < 3) return "here";
		double toTarget = Math.toDegrees(Math.atan2(-dx, dz)); // the yaw that faces Craftie
		double rel = ((toTarget - mc.player.getYRot()) % 360 + 360) % 360; // 0 = straight ahead, 90 = to your right
		String updown = dy > 4 ? " ▲" : dy < -4 ? " ▼" : "";
		return dist + "m " + ARROWS[(int) Math.round(rel / 45) % 8] + updown;
	}

	private static String describe(CraftieStatus.Entry e) {
		String j = e.job();
		if (j == null || j.isBlank()) return e.following() ? "following you" : "waiting";
		if (j.startsWith("chore: ")) j = j.substring(7);
		if (j.startsWith("goto player")) return "coming to you";
		return j;
	}

	private static String fit(Font font, String s, int max) {
		if (font.width(s) <= max) return s;
		while (s.length() > 1 && font.width(s + "…") > max) s = s.substring(0, s.length() - 1);
		return s + "…";
	}
}
