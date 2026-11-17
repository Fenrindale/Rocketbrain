package fixture.boot;
import jakarta.persistence.AttributeConverter;
import jakarta.persistence.Converter;
import java.util.Locale;
@Converter(autoApply=false)
public class TrimUpperConverter implements AttributeConverter<String,String> {
    @Override public String convertToDatabaseColumn(String value) { return value==null?null:value.trim().toUpperCase(Locale.ROOT); }
    @Override public String convertToEntityAttribute(String value) { return value; }
}
