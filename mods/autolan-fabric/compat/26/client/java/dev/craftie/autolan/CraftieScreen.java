package dev.craftie.autolan;

import com.mojang.blaze3d.platform.InputConstants;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.client.gui.components.Button;
import net.minecraft.client.gui.components.EditBox;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.client.input.KeyEvent;
import net.minecraft.network.chat.Component;

/** Type an order for Craftie, or press a quick button. Orders go as private messages. */
public class CraftieScreen extends Screen {
	private static final String[][] QUICK = {
		{ "Follow me", "follow me" }, { "Stop", "stop" }, { "Come here", "come here" },
		{ "Bring a helper", "join" }, { "Send helper home", "exit" },
	};
	private EditBox box;

	public CraftieScreen() { super(Component.literal("Tell " + Settings.name + " what to do")); }

	@Override
	protected void init() {
		int w = Math.min(320, width - 40), x = (width - w) / 2, y = height / 2 - 30;
		box = new EditBox(font, x, y, w, 20, title);
		box.setMaxLength(200);
		box.setHint(Component.literal("build me a house, get 20 iron, ..."));
		addRenderableWidget(box);
		setInitialFocus(box);
		int gap = 4, bw = (w - gap * 2) / 3, by = y + 28;
		for (int i = 0; i < QUICK.length; i++) {
			String order = QUICK[i][1];
			int row = i / 3, col = i % 3;
			addRenderableWidget(Button.builder(Component.literal(QUICK[i][0]), b -> send(order))
				.bounds(x + col * (bw + gap), by + row * 24, bw, 20).build());
		}
	}

	private void send(String order) {
		onClose();
		CraftieClient.order(order);
	}

	@Override
	public boolean keyPressed(KeyEvent event) {
		if (event.key() == InputConstants.KEY_RETURN || event.key() == InputConstants.KEY_NUMPADENTER) {
			String text = box.getValue().trim();
			if (!text.isEmpty()) send(text); else onClose();
			return true;
		}
		return super.keyPressed(event);
	}

	@Override
	public void extractRenderState(GuiGraphicsExtractor g, int mouseX, int mouseY, float delta) {
		super.extractRenderState(g, mouseX, mouseY, delta);
		g.centeredText(font, title, width / 2, height / 2 - 46, 0xFFFFFFFF);
	}

	@Override
	public boolean isPauseScreen() { return false; }
}
