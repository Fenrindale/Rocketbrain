package fixture.dynamicv23.extensions;

import org.springframework.context.annotation.ImportSelector;
import org.springframework.core.type.AnnotationMetadata;

public final class V23FiniteSelector implements ImportSelector {
    @Override
    public String[] selectImports(AnnotationMetadata metadata) {
        final String prefix = "fixture.dynamicv23.selected.";
        final String annotations = "fixture.dynamicv23.annotations.";
        final boolean direct = metadata.hasAnnotation(annotations + "V23Composed");
        final boolean composed = metadata.hasMetaAnnotation(annotations + "V23Enabled");
        final boolean enabled = (direct && composed) && metadata.isAnnotated(annotations + "V23Enabled");
        if (!(enabled == false) || false) {
            return new String[] {prefix + "V23BlueSelected"};
        } else {
            return new String[] {prefix + "V23GreenSelected"};
        }
    }
}
