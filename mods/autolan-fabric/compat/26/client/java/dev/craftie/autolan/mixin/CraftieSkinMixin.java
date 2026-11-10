package dev.craftie.autolan.mixin;

import java.util.regex.Pattern;

import com.mojang.authlib.GameProfile;
import net.minecraft.client.multiplayer.PlayerInfo;
import net.minecraft.core.ClientAsset;
import net.minecraft.resources.Identifier;
import net.minecraft.world.entity.player.PlayerModelType;
import net.minecraft.world.entity.player.PlayerSkin;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/**
 * Gives Craftie and its helpers (Craftie1, Craftie2, ...) Craftie's own skin, built into this mod.
 * Offline players have no skin from Mojang, so without this they show up as Steve/Alex.
 */
@Mixin(PlayerInfo.class)
public abstract class CraftieSkinMixin {
	private static final Pattern CRAFTIE = Pattern.compile("(?i)craftie\\d*");
	private static final PlayerSkin SKIN = new PlayerSkin(
		new ClientAsset.ResourceTexture(Identifier.fromNamespaceAndPath("craftie_autolan", "entity/craftie")),
		null, null, PlayerModelType.SLIM, false);

	@Shadow public abstract GameProfile getProfile();

	@Inject(method = "getSkin", at = @At("HEAD"), cancellable = true)
	private void craftie$skin(CallbackInfoReturnable<PlayerSkin> cir) {
		GameProfile p = getProfile();
		if (p != null && p.name() != null && CRAFTIE.matcher(p.name()).matches()) cir.setReturnValue(SKIN);
	}
}
