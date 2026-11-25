package processors.fixture;

import org.mapstruct.Mapper;
import org.mapstruct.Mapping;

@Mapper
public interface ProfileMapper {
    @Mapping(target = "name", source = "label")
    ProfileDto map(Profile value);
}
