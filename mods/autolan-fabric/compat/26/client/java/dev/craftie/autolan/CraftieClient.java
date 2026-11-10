package dev.craftie.autolan;

import com.mojang.blaze3d.platform.InputConstants;
import com.mojang.brigadier.arguments.StringArgumentType;
import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.command.v2.ClientCommandRegistrationCallback;
import net.fabricmc.fabric.api.client.command.v2.ClientCommands;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.fabricmc.fabric.api.client.keymapping.v1.KeyMappingHelper;
import net.fabricmc.fabric.api.client.rendering.v1.hud.HudElementRegistry;
import net.fabricmc.fabric.api.client.rendering.v1.hud.VanillaHudElements;
import net.minecraft.client.KeyMapping;
import net.minecraft.client.Minecraft;
import net.minecraft.resources.Identifier;

/**
 * The in-game side of Craftie, all on your own PC (friends need nothing):
 * a status panel, a key (G) that opens an order box, and the /craftie command.
 * Settings (hud, name) are in config/craftie-autolan.properties: see Settings.
 */
public class CraftieClient implements ClientModInitializer {
	private static boolean openScreen; // /craftie asked for the order box; open it once chat has closed

	@Override
	public void onInitializeClient() {
		CraftieStatus.start();
		HudElementRegistry.attachElementBefore(VanillaHudElements.CHAT, Identifier.fromNamespaceAndPath("craftie_autolan", "status"), CraftieHud::draw);

		KeyMapping.Category category = KeyMapping.Category.register(Identifier.fromNamespaceAndPath("craftie_autolan", "craftie"));
		KeyMapping orderKey = KeyMappingHelper.registerKeyMapping(new KeyMapping("key.craftie_autolan.order", InputConstants.KEY_G, category));
		KeyMapping hudKey = KeyMappingHelper.registerKeyMapping(new KeyMapping("key.craftie_autolan.hud", InputConstants.UNKNOWN.getValue(), category));
		ClientTickEvents.END_CLIENT_TICK.register(client -> {
			while (hudKey.consumeClick()) Settings.hud = !Settings.hud;
			boolean open = openScreen;
			openScreen = false;
			while (orderKey.consumeClick()) open = true;
			if (open && client.player != null && client.gui.screen() == null) client.gui.setScreen(new CraftieScreen());
		});

		ClientCommandRegistrationCallback.EVENT.register((dispatcher, context) -> dispatcher.register(
			ClientCommands.literal("craftie")
				.executes(c -> { openScreen = true; return 1; })
				.then(ClientCommands.argument("order", StringArgumentType.greedyString())
					.executes(c -> { order(StringArgumentType.getString(c, "order")); return 1; }))));
	}

	/** Sends an order to Craftie as a private message, so nobody else in the world sees it. */
	static void order(String text) {
		Minecraft mc = Minecraft.getInstance();
		if (mc.player == null || mc.getConnection() == null) return;
		if (mc.getConnection().getPlayerInfo(Settings.name) == null) {
			Compat.tell(mc, "§a[Craftie]§r " + Settings.name + " isn't in this world right now.");
			return;
		}
		text = text.replaceAll("\\s+", " ").trim();
		if (text.length() > 200) text = text.substring(0, 200);
		mc.getConnection().sendCommand("msg " + Settings.name + " " + text);
	}
}
