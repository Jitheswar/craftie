package dev.craftie.autolan.mixin;

import java.util.regex.Pattern;

import com.google.common.collect.ImmutableMultimap;
import com.mojang.authlib.GameProfile;
import com.mojang.authlib.properties.Property;
import com.mojang.authlib.properties.PropertyMap;
import net.minecraft.core.UUIDUtil;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/**
 * When Craftie (or a helper: Craftie1, Craftie2, ...) joins the world you host, give its profile
 * Craftie's skin, signed by Mojang (via mineskin.org). Your friends' games then show the skin
 * too, without any mod. Offline players normally have no skin at all.
 */
@Mixin(UUIDUtil.class)
public abstract class CraftieProfileMixin {
	private static final Pattern CRAFTIE = Pattern.compile("(?i)craftie\\d*");
	private static final String VALUE = "ewogICJ0aW1lc3RhbXAiIDogMTYyMTI4NjAwODczMywKICAicHJvZmlsZUlkIiA6ICIzOTg5OGFiODFmMjU0NmQxOGIyY2ExMTE1MDRkZGU1MCIsCiAgInByb2ZpbGVOYW1lIiA6ICJNeVV1aWRJcyIsCiAgInNpZ25hdHVyZVJlcXVpcmVkIiA6IHRydWUsCiAgInRleHR1cmVzIiA6IHsKICAgICJTS0lOIiA6IHsKICAgICAgInVybCIgOiAiaHR0cDovL3RleHR1cmVzLm1pbmVjcmFmdC5uZXQvdGV4dHVyZS85ZjRmMjI4M2NlYmVhYmU3ODI3MWZkMDIxM2ViMTViNTNiNDJlYzRlMWY3MjQzYmMzY2E4MTZhYzVlZDVkZjQ4IiwKICAgICAgIm1ldGFkYXRhIiA6IHsKICAgICAgICAibW9kZWwiIDogInNsaW0iCiAgICAgIH0KICAgIH0KICB9Cn0=";
	private static final String SIGNATURE = "jQOs4wryMYvtzzx2Gcoq+5W0iKYySh1a3O99wBe3QGqVCA0LOvMezMelRBdlM4P5ViM1Gnc26e/bDiJKdxVdpjXbOOY32cbERZPQhSixkkn/jBGhjD94RPCcegYpU/oE0ddNkMrShJCvtaL/E7k13cP9enAJSahG5fO/6FV4pF0axW1TZOjxO22ivVatbKjK4WShubZiGct4gt4NPkfd/csTWW4k+Ha2CuQH8hlrYPRyRu7jFuMqvx4Ny2XZRUR0Vcp6UGB8txgU5HqgszPNPB+mbQj/mshP241SITdBHCwhxa1UhlxXOncZ2i5WqKa0EUOZLlBVp/fPKfiqdpDtlIACbL07sVQsMq3/tOfyG8BrLqZwz3QqZ6i87qgTIxcvtdsZahrji2HQX3wgJ/+tn/Y4CoFNGk8OhmnJx+MJ9rC4ityTfvlmu8Ta123Yvp4/1GGw5WtGLK2ep2d1mLXxjcZUs7KWuL9INm4C8sO8Le0rV20wEyGIHSjFZEFtSszYnbIsgVbnfngbyvM67DwCXeKyU2SjyJH4+U8Dg6iUp93wes8MdJfquHYgvYc/lkOvNUaj4+40NKrjuVyD7JVSk7+ofa9hOjAojXgbqI/7g9zIVvIuik2Pk90fSwCw22RImNyXB9Cz2idvd3PyMxs1STy6N4aBEhUI0Z0y3xWroQY=";

	@Inject(method = "createOfflineProfile", at = @At("RETURN"), cancellable = true)
	private static void craftie$skin(String name, CallbackInfoReturnable<GameProfile> cir) {
		if (name == null || !CRAFTIE.matcher(name).matches()) return;
		GameProfile p = cir.getReturnValue();
		cir.setReturnValue(new GameProfile(p.id(), p.name(),
			new PropertyMap(ImmutableMultimap.of("textures", new Property("textures", VALUE, SIGNATURE)))));
	}
}
