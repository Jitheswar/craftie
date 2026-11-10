package dev.craftie.autolan;

import net.minecraft.client.Minecraft;
import net.minecraft.client.server.IntegratedServer;
import net.minecraft.network.chat.Component;

/** The few calls that differ between Minecraft versions. This one: 1.20.5 to 1.21.x. */
final class Compat {
	private Compat() {}

	/** Opens the world to LAN, keeping its own game mode and cheat setting. */
	static boolean openToLan(IntegratedServer world, int port) {
		return world.publishServer(world.getDefaultGameType(), world.getPlayerList().isAllowCommandsForAllPlayers(), port);
	}

	/** A chat line only you see. */
	static void tell(Minecraft client, String text) {
		if (client.player != null) client.player.displayClientMessage(Component.literal(text), false);
	}
}
