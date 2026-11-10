package dev.craftie.autolan;

import net.minecraft.client.Minecraft;
import net.minecraft.client.server.IntegratedServer;
import net.minecraft.network.chat.Component;
import net.minecraft.server.MinecraftServer;

/** The few calls that differ between Minecraft versions. This one: 26.x. */
final class Compat {
	private Compat() {}

	/** Opens the world to LAN. Since 26.x the world keeps its own game mode and command access. */
	static boolean openToLan(IntegratedServer world, int port) {
		return world.publishServer(MinecraftServer.MultiplayerScope.LAN, port);
	}

	/** A chat line only you see. */
	static void tell(Minecraft client, String text) {
		if (client.player != null) client.player.sendSystemMessage(Component.literal(text));
	}
}
