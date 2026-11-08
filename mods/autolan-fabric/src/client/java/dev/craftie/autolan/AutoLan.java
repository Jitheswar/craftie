package dev.craftie.autolan;

import java.io.IOException;
import java.io.Reader;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Properties;

import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.client.Minecraft;
import net.minecraft.client.server.IntegratedServer;
import net.minecraft.network.chat.Component;
import net.minecraft.util.HttpUtil;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Opens every singleplayer world to LAN once you're in it, with Online Mode off so
 * offline accounts (and the Craftie bot) can join. Keeps the world's own game mode
 * and cheat setting. Runs on the client thread after the player exists, exactly when
 * the vanilla "Open to LAN" button would. Disable with enabled=false in
 * config/craftie-autolan.properties.
 */
public class AutoLan implements ClientModInitializer {
	private static final Logger LOG = LoggerFactory.getLogger("craftie-autolan");
	private IntegratedServer handled; // the world we've already dealt with

	@Override
	public void onInitializeClient() {
		if (!enabled()) { LOG.info("Craftie Auto LAN is turned off in config/craftie-autolan.properties"); return; }
		ClientTickEvents.END_CLIENT_TICK.register(this::tick);
	}

	private void tick(Minecraft client) {
		IntegratedServer world = client.getSingleplayerServer();
		if (world == null) { handled = null; return; }       // not in a singleplayer world
		if (world == handled || client.player == null) return; // wait until we're actually in it
		handled = world;
		if (world.isPublished()) { world.setUsesAuthentication(false); return; } // already open: just allow offline joins
		try {
			int port = HttpUtil.getAvailablePort();
			world.setUsesAuthentication(false); // Online Mode off: offline accounts can join
			boolean cheats = world.getPlayerList().isAllowCheatsForAllPlayers();
			if (world.publishServer(world.getDefaultGameType(), cheats, port)) {
				// Again after opening: other LAN mods (e.g. Custom LAN) may apply their own setting while publishing.
				world.setUsesAuthentication(false);
				LOG.info("Opened world to LAN on port {} (online mode off) for Craftie", port);
				client.player.displayClientMessage(Component.literal("§a[Craftie]§r World opened to LAN on port " + port + ". Craftie will join in a few seconds."), false);
			} else {
				LOG.warn("Couldn't open the world to LAN");
			}
		} catch (Exception e) {
			// Never take the game down: worst case, you press Open to LAN yourself.
			LOG.error("Craftie Auto LAN failed; use Esc -> Open to LAN instead", e);
		}
	}

	private static boolean enabled() {
		Path file = FabricLoader.getInstance().getConfigDir().resolve("craftie-autolan.properties");
		try {
			if (!Files.exists(file)) {
				Files.writeString(file, "# Set to false to stop opening worlds to LAN automatically.\nenabled=true\n");
				return true;
			}
			Properties p = new Properties();
			try (Reader r = Files.newBufferedReader(file)) { p.load(r); }
			return !"false".equalsIgnoreCase(p.getProperty("enabled", "true").trim());
		} catch (IOException e) {
			return true;
		}
	}
}
