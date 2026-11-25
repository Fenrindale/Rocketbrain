package processors.fixture;

public final class ProcessorProbe {
    public static void main(String[] args) {
        Profile value = new Profile();
        ProfileMapper mapper = new ProfileMapperImpl();
        System.out.print(value.getLabel() + ":" + mapper.map(value).name);
    }
}
