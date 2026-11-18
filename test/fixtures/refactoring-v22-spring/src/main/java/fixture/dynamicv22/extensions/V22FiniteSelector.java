package fixture.dynamicv22.extensions;

import org.springframework.context.annotation.ImportSelector;
import org.springframework.core.type.AnnotationMetadata;

public final class V22FiniteSelector implements ImportSelector {
    @Override
    public String[] selectImports(AnnotationMetadata metadata) {
        final String prefix = "fixture.dynamicv22.selected.";
        if (metadata.isAnnotated("org.springframework.context.annotation.Profile")) {
            return new String[] {prefix + "V22BlueSelected"};
        } else {
            return new String[] {prefix + "V22GreenSelected"};
        }
    }
}
