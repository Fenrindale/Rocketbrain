package fixture.fielddelete;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

@Component
public final class FieldDeleteService {
    private int obsoletePreviewCount;
    private static String obsoleteStaticNote;

    @Value("${rocketbrain.safe-field.binding}")
    private int injectedOnlyBySpring;

    private int referencedCount;
    private int adjacentFirst, adjacentSecond;
    private int initializerEffects;
    private int effectfulField = recordInitialization();

    private int recordInitialization() {
        return ++initializerEffects;
    }

    public int currentValue() {
        this.referencedCount = 40;
        return this.referencedCount + 2;
    }

    public int initializationEffects() {
        return initializerEffects;
    }
}
